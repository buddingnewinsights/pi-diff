import { execFileSync } from "node:child_process";

import { type ExtensionAPI, type ExtensionContext, copyToClipboard, type KeybindingsManager, type MessageRenderOptions, type SessionBeforeForkEvent, type SessionBeforeSwitchEvent, type SessionStartEvent, type SessionTreeEvent, type Theme } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, Text, type TUI } from "@earendil-works/pi-tui";

import { type ReviewDiff, type ReviewDiffMode, readGitDiff } from "./git.js";
import { getSelectedPreviewLine, selectPreviewLineForComment, syncPreviewSelection } from "./model.js";
import { buildReviewDiffPrompt } from "./prompt.js";
import {
	addDraftComment,
	approveAllComments,
	cloneReviewDiffSession,
	createDraftComment,
	createReviewDiffSession,
	deleteSelectedComment,
	editSelectedComment,
	getLatestReviewDiffSession,
	getSelectedComment,
	getSelectedFile,
	getSelectedHunk,
	getSubmittableComments,
	persistReviewDiffSession,
	type ReviewDraftComment,
	type ReviewDiffSession,
	syncReviewDiffSession,
} from "./session.js";
import { checkHunkAvailable, launchHunkReview, type HunkComment } from "./hunk-bridge.js";
import { ReviewDiffPane, type ReviewDiffPaneAction } from "./tui.js";

const REVIEW_DIFF_POLL_MS = 1000;

// ─── Hunk availability cache (checked once per process lifetime) ──────────────

let _hunkAvailable: boolean | undefined = undefined;
let _hunkWarningShown = false;

async function hunkAvailableCached(): Promise<boolean> {
	if (_hunkAvailable === undefined) {
		_hunkAvailable = await checkHunkAvailable();
	}
	return _hunkAvailable;
}

// ─── Helpers for mapping Hunk comments to ReviewDraftComment ─────────────────

function hunkCommentToDraftComment(
	comment: HunkComment,
	index: number,
): ReviewDraftComment {
	return {
		id: `H${String(index + 1).padStart(3, "0")}`,
		file: comment.filePath,
		line: comment.newLine || comment.oldLine || undefined,
		oldNum: comment.oldLine || null,
		newNum: comment.newLine || null,
		body: comment.summary,
		createdAt: new Date().toISOString(),
		status: "approved",
	};
}

function mapHunkCommentsToDraftComments(hunkComments: HunkComment[]): ReviewDraftComment[] {
	return hunkComments.map((comment, index) => hunkCommentToDraftComment(comment, index));
}

export function registerReviewDiffCommand(pi: ExtensionAPI, cwd: string): void {
	let latestSession: ReviewDiffSession | null = null;

	const reconstruct = (ctx: ExtensionContext) => {
		latestSession = getLatestReviewDiffSession(ctx);
	};

	pi.on?.("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => reconstruct(ctx));
	pi.on?.("session_before_switch", async (_event: SessionBeforeSwitchEvent, ctx: ExtensionContext) => reconstruct(ctx));
	pi.on?.("session_before_fork", async (_event: SessionBeforeForkEvent, ctx: ExtensionContext) => reconstruct(ctx));
	pi.on?.("session_tree", async (_event: SessionTreeEvent, ctx: ExtensionContext) => reconstruct(ctx));

	pi.registerMessageRenderer?.("review-diff-submit", (message: { content: string | Array<{ type: string; text?: string }>; details?: Record<string, unknown> }, _options: MessageRenderOptions, theme: Theme) => {
		const text = typeof message.content === "string" ? message.content : message.content.map((c) => c.text ?? "").join("");
		return new Text(theme.fg("success", theme.bold("review-diff ")) + text, 0, 0);
	});
	pi.registerMessageRenderer?.("review-diff-status", (message: { content: string | Array<{ type: string; text?: string }>; details?: Record<string, unknown> }, _options: MessageRenderOptions, theme: Theme) => {
		const text = typeof message.content === "string" ? message.content : message.content.map((c) => c.text ?? "").join("");
		const level =
			message.details?.level === "error" ? "error" : message.details?.level === "warning" ? "warning" : "muted";
		return new Text(theme.fg(level, theme.bold("review-diff ")) + text, 0, 0);
	});

	pi.registerCommand?.("review-diff", {
		description: "Open an interactive local Git review overlay and submit drafted comments back to Pi",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const items = [
				{ value: "working-tree", label: "working-tree", description: "Review uncommitted local changes" },
				...listGitBranches(cwd).map((branch) => ({
					value: branch,
					label: branch,
					description: `Review ${branch}...HEAD`,
				})),
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args: string | undefined, ctx: ExtensionContext) => {
			if (!ctx.hasUI) {
				notifyReviewDiff(pi, ctx, "/review-diff requires interactive mode", "error");
				return;
			}

			let mode: ReviewDiffMode;
			try {
				mode = parseReviewDiffArgs(args, latestSession?.mode);
			} catch (error) {
				notifyReviewDiff(pi, ctx, error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const initialDiff = loadReviewDiff(cwd, mode);
			if (!initialDiff.ok) {
				notifyReviewDiff(pi, ctx, initialDiff.message, "error");
				return;
			}
			const diff = initialDiff.diff;

			const available = await hunkAvailableCached();
			if (available) {
				// ── Hunk path ────────────────────────────────────────────────
				await handleHunkReview(pi, ctx, cwd, diff, mode, latestSession);
				return;
			}

			// ── Fallback path (TUI) ─────────────────────────────────────────
			if (!_hunkWarningShown) {
				_hunkWarningShown = true;
				notifyReviewDiff(
					pi,
					ctx,
					"Hunk not found — using built-in review UI. Install with: npm i -g hunkdiff",
					"warning",
				);
			}

			await handleTuiReview(pi, ctx, cwd, diff, mode, latestSession);
		},
	});
}

/**
 * Hunk review path: pipe git diff to `hunk patch -`, wait for exit,
 * map returned comments to ReviewDraftComment[], and submit.
 */
async function handleHunkReview(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cwd: string,
	diff: ReviewDiff,
	mode: ReviewDiffMode,
	latestSession: ReviewDiffSession | null,
): Promise<void> {
	let session =
		latestSession && sameMode(latestSession.mode, mode)
			? cloneReviewDiffSession(latestSession)
			: createReviewDiffSession(mode);
	session = syncReviewDiffSession(session, diff);
	persistReviewDiffSession(pi, session);

	const hunkResult = await launchHunkReview(cwd, diff.raw);

	// Even if the process returned non-zero, attempt to harvest comments
	const hunkComments = hunkResult.comments ?? [];
	if (hunkComments.length > 0) {
		const draftComments = mapHunkCommentsToDraftComments(hunkComments);
		for (const dc of draftComments) {
			addDraftComment(session, dc);
		}
		persistReviewDiffSession(pi, session);
	}

	const comments = getSubmittableComments(session);
	if (comments.length > 0) {
		const prompt = buildReviewDiffPrompt(diff, session);
		if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		} else {
			pi.sendUserMessage(prompt);
		}
		session.submittedAt = Date.now();
		persistReviewDiffSession(pi, session);
		pi.sendMessage?.({
			customType: "review-diff-submit",
			content: `${comments.length} comment(s) queued for Pi from ${session.mode.type === "branch" ? `${session.mode.base}...HEAD` : "working tree"}`,
			display: true,
			details: { commentCount: comments.length, mode: session.mode },
		});
		ctx.ui.notify(`Queued ${comments.length} review comment(s) for Pi`, "info");
	} else {
		ctx.ui.notify("Hunk review completed with no comments to submit.", "info");
	}
}

/**
 * Legacy TUI review path: open the ReviewDiffPane overlay with the existing
 * session management, refresh, approve-all, and submit flows.
 */
async function handleTuiReview(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	cwd: string,
	diff: ReviewDiff,
	mode: ReviewDiffMode,
	latestSession: ReviewDiffSession | null,
): Promise<void> {
	let session =
		latestSession && sameMode(latestSession.mode, mode)
			? cloneReviewDiffSession(latestSession)
			: createReviewDiffSession(mode);
	session = syncReviewDiffSession(session, diff);
	syncPreviewSelection(session, diff);
	persistReviewDiffSession(pi, session);

	// eslint-disable-next-line no-constant-condition
	while (true) {
		const paneResult = await openReviewDiffPane(ctx, cwd, diff, session);
		diff = paneResult.diff;
		session = paneResult.session;
		const action = paneResult.action;
		if (action.type === "cancel") {
			persistReviewDiffSession(pi, session);
			return;
		}
		if (action.type === "refresh") {
			const refreshed = loadReviewDiff(cwd, session.mode);
			if (!refreshed.ok) {
				notifyReviewDiff(pi, ctx, refreshed.message, "error");
				continue;
			}
			diff = refreshed.diff;
			session = syncReviewDiffSession(session, diff);
			syncPreviewSelection(session, diff);
			persistReviewDiffSession(pi, session);
			continue;
		}
		if (action.type === "approve-all") {
			approveAllComments(session);
			selectPreviewLineForComment(session, diff);
			syncPreviewSelection(session, diff);
			persistReviewDiffSession(pi, session);
			continue;
		}
		if (action.type === "add-comment") {
			const file = getSelectedFile(diff, session);
			const hunk = getSelectedHunk(diff, session);
			const previewLine = getSelectedPreviewLine(diff, session);
			if (!file || !hunk) {
				ctx.ui.notify("Select a file and hunk before drafting a comment", "warning");
				continue;
			}
			const lineNumber = previewLine?.newNum ?? previewLine?.oldNum ?? firstChangedLine(hunk) ?? hunk.newStart;
			const body = await ctx.ui.editor(
				`Draft review comment for ${file.path}`,
				commentSeed(file.path, hunk.id, lineNumber),
			);
			if (!body || !body.trim()) continue;
			addDraftComment(
				session,
				createDraftComment({
					session,
					file: file.path,
					body: body.trim(),
					line: lineNumber,
					hunkId: previewLine?.hunkId ?? hunk.id,
					previewLineId: previewLine?.id,
					oldNum: previewLine?.oldNum,
					newNum: previewLine?.newNum,
					lineType: previewLine?.kind === "hunk-header" ? undefined : previewLine?.kind,
				}),
			);
			syncPreviewSelection(session, diff);
			persistReviewDiffSession(pi, session);
			continue;
		}
		if (action.type === "edit-comment") {
			const selected = getSelectedComment(session);
			if (!selected) {
				ctx.ui.notify("No drafted comment selected. Press c to draft one first, or Tab to Comments.", "warning");
				continue;
			}
			const body = await ctx.ui.editor(`Edit ${selected.id}`, selected.body);
			if (!body || !body.trim()) continue;
			editSelectedComment(session, body.trim());
			selectPreviewLineForComment(session, diff);
			persistReviewDiffSession(pi, session);
			continue;
		}
		if (action.type === "open-location") {
			const location = buildSelectedLocationText(diff, session);
			if (!location) {
				ctx.ui.notify("No selected review location to open", "warning");
				continue;
			}
			ctx.ui.setEditorText(location);
			ctx.ui.notify("Selected review location loaded into the editor", "info");
			persistReviewDiffSession(pi, session);
			return;
		}
		if (action.type === "copy-location") {
			const location = buildSelectedLocationText(diff, session);
			if (!location) {
				ctx.ui.notify("No selected review location to copy", "warning");
				continue;
			}
			try {
				await copyToClipboard(location);
				ctx.ui.notify("Selected review location copied to clipboard", "info");
			} catch {
				ctx.ui.setEditorText(location);
				ctx.ui.notify("Clipboard unavailable; selected review location loaded into the editor", "warning");
			}
			persistReviewDiffSession(pi, session);
			continue;
		}
		if (action.type === "delete-comment") {
			const removed = deleteSelectedComment(session);
			if (removed) ctx.ui.notify(`Removed ${removed.id}`, "info");
			selectPreviewLineForComment(session, diff);
			syncPreviewSelection(session, diff);
			persistReviewDiffSession(pi, session);
			continue;
		}
		if (action.type === "submit") {
			const comments = getSubmittableComments(session);
			if (comments.length === 0) {
				ctx.ui.notify("No approved comments selected for submission", "warning");
				continue;
			}
			const prompt = buildReviewDiffPrompt(diff, session);
			if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			} else {
				pi.sendUserMessage(prompt);
			}
			session.submittedAt = Date.now();
			persistReviewDiffSession(pi, session);
			pi.sendMessage?.({
				customType: "review-diff-submit",
				content: `${comments.length} comment(s) queued for Pi from ${session.mode.type === "branch" ? `${session.mode.base}...HEAD` : "working tree"}`,
				display: true,
				details: { commentCount: comments.length, mode: session.mode },
			});
			ctx.ui.notify(`Queued ${comments.length} review comment(s) for Pi`, "info");
			return;
		}
	}
}

async function openReviewDiffPane(
	ctx: ExtensionContext,
	cwd: string,
	diff: ReviewDiff,
	session: ReviewDiffSession,
): Promise<{ action: ReviewDiffPaneAction; diff: ReviewDiff; session: ReviewDiffSession }> {
	let liveDiff = diff;
	let liveSession = session;
	const action = await ctx.ui.custom(
		(tui: TUI, theme: Theme, _kb: KeybindingsManager, done: (action: ReviewDiffPaneAction) => void) => {
			const pane = new ReviewDiffPane(liveDiff, liveSession, theme, done, {
				requestRender: () => tui.requestRender(),
			});
			let interval: ReturnType<typeof setInterval> | null = setInterval(() => {
				const refreshed = loadReviewDiff(cwd, liveSession.mode);
				if (!refreshed.ok || refreshed.diff.raw === liveDiff.raw) return;
				liveDiff = refreshed.diff;
				liveSession = syncReviewDiffSession(liveSession, liveDiff);
				syncPreviewSelection(liveSession, liveDiff);
				pane.updateReviewState(liveDiff, liveSession);
				tui.requestRender();
			}, REVIEW_DIFF_POLL_MS);
			return {
				render: (width: number) => pane.render(width),
				invalidate: () => pane.invalidate(),
				handleInput: (data: string) => {
					pane.handleInput(data);
					tui.requestRender();
				},
				dispose: () => {
					if (interval) {
						clearInterval(interval);
						interval = null;
					}
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "100%",
				minWidth: 84,
				maxHeight: "94%",
				margin: 1,
			},
		},
	);
	return { action, diff: liveDiff, session: liveSession };
}

function parseReviewDiffArgs(args: string | undefined, previousMode?: ReviewDiffMode): ReviewDiffMode {
	const trimmed = args?.trim() ?? "";
	if (!trimmed) return previousMode ?? { type: "working-tree" };
	if (trimmed === "working-tree" || trimmed === "worktree") return { type: "working-tree" };
	const tokens = trimmed.split(/\s+/).filter(Boolean);
	if (tokens[0] === "--base") {
		if (!tokens[1] || tokens.length > 2) {
			throw new Error("Usage: /review-diff [working-tree|--base <branch>|<branch>]");
		}
		return { type: "branch", base: tokens[1] };
	}
	if (tokens.length === 1) return { type: "branch", base: tokens[0] };
	throw new Error("Usage: /review-diff [working-tree|--base <branch>|<branch>]");
}

function listGitBranches(cwd: string): string[] {
	try {
		const raw = execFileSync("git", ["branch", "--format=%(refname:short)"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return raw
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);
	} catch {
		return [];
	}
}

function sameMode(left: ReviewDiffMode, right: ReviewDiffMode): boolean {
	if (left.type !== right.type) return false;
	if (left.type === "branch" && right.type === "branch") return left.base === right.base;
	return true;
}

function loadReviewDiff(
	cwd: string,
	mode: ReviewDiffMode,
): { ok: true; diff: ReviewDiff } | { ok: false; message: string } {
	try {
		return { ok: true, diff: readGitDiff(cwd, mode) };
	} catch (error) {
		return { ok: false, message: formatReviewDiffError(error, mode) };
	}
}

function formatReviewDiffError(error: unknown, mode: ReviewDiffMode): string {
	const target = mode.type === "branch" ? `${mode.base}...HEAD` : "working tree";
	const detail = extractGitErrorDetail(error);
	if (!detail) {
		return `Could not read git diff for ${target}.`;
	}
	const normalized = detail.toLowerCase();
	if (
		normalized.includes("bad revision") ||
		normalized.includes("unknown revision") ||
		normalized.includes("ambiguous argument") ||
		normalized.includes("unknown option")
	) {
		return `Could not read git diff for ${target}. Verify the branch or ref exists.`;
	}
	return `Could not read git diff for ${target}: ${detail}`;
}

function extractGitErrorDetail(error: unknown): string {
	if (!error || typeof error !== "object") {
		return error instanceof Error ? error.message : String(error ?? "").trim();
	}
	const stderr = "stderr" in error ? error.stderr : undefined;
	if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
	if (Buffer.isBuffer(stderr) && stderr.byteLength > 0) return stderr.toString("utf8").trim();
	const message = "message" in error ? error.message : undefined;
	return typeof message === "string" ? message.trim() : "";
}

function notifyReviewDiff(pi: ExtensionAPI, ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx?.ui && typeof ctx.ui.notify === "function") {
		ctx.ui.notify(message, level);
		return;
	}
	if (typeof pi.sendMessage === "function") {
		pi.sendMessage({
			customType: "review-diff-status",
			content: message,
			display: true,
			details: { level },
		});
		return;
	}
	console.warn(`review-diff (${level}): ${message}`);
}

function buildSelectedLocationText(diff: ReviewDiff, session: ReviewDiffSession): string | null {
	const file = getSelectedFile(diff, session);
	const hunk = getSelectedHunk(diff, session);
	const previewLine = getSelectedPreviewLine(diff, session);
	if (!file) return null;
	const line = previewLine?.newNum ?? previewLine?.oldNum ?? (hunk ? (firstChangedLine(hunk) ?? hunk.newStart) : null);
	const hunkText = hunk ? `\nHunk: ${hunk.id} ${hunk.header}` : "";
	const selectedText = previewLine ? `\nSelected line (${previewLine.kind}): ${previewLine.content}` : "";
	return `Review this location:\n\nFile: ${file.path}${line ? `:${line}` : ""}${hunkText}${selectedText}\n\nTask: Inspect this code location in the current git diff and explain what should be changed, if anything.`;
}

function firstChangedLine(hunk: {
	lines: Array<{ type: string; oldNum: number | null; newNum: number | null }>;
	newStart: number;
}): number | null {
	const changed = hunk.lines.find((line) => line.type === "add" || line.type === "del");
	return changed?.newNum ?? changed?.oldNum ?? null;
}

function commentSeed(file: string, hunkId: string, line: number | null): string {
	return `Comment on ${file}${line ? `:${line}` : ""} (${hunkId})\n\n`;
}
