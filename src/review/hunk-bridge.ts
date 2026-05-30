/**
 * hunk-bridge.ts — Thin subprocess wrapper for the `hunk` CLI.
 *
 * Detects availability of the `hunk` binary, pipes unified diff content to
 * `hunk patch -` for interactive review, and extracts session comments
 * after the review completes.
 */

import { spawn, execSync } from "node:child_process";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface HunkComment {
	filePath: string;
	newLine: number;
	oldLine: number;
	summary: string;
}

export interface HunkReviewResult {
	available: boolean;
	comments?: HunkComment[];
}

// ─── Availability Check ──────────────────────────────────────────────────────

/**
 * Check whether the `hunk` CLI is available on the current PATH.
 *
 * Runs `hunk --version` with a short timeout and returns `true` if it
 * succeeds, `false` otherwise.
 */
export async function checkHunkAvailable(): Promise<boolean> {
	try {
		execSync("hunk --version", { stdio: "ignore", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

// ─── Comment Parsing ─────────────────────────────────────────────────────────

/**
 * Parse raw JSON output from `hunk session comment list --json` into
 * `HunkComment[]`.
 *
 * Handles both snake_case and camelCase field names emitted by the CLI.
 */
export function parseHunkComments(rawJson: string): HunkComment[] {
	try {
		const parsed = JSON.parse(rawJson);
		if (!Array.isArray(parsed)) return [];
		return parsed.map((item: Record<string, unknown>) => ({
			filePath: String(item.filePath ?? item.file_path ?? item.file ?? ""),
			newLine: Number(item.newLine ?? item.new_line ?? 0),
			oldLine: Number(item.oldLine ?? item.old_line ?? 0),
			summary: String(item.summary ?? item.comment ?? ""),
		}));
	} catch {
		return [];
	}
}

// ─── Comment Extraction ──────────────────────────────────────────────────────

/**
 * Run `hunk session comment list --repo <cwd> --json` and return parsed
 * comments. Returns an empty array on any failure (CLI not found,
 * no active session, parse error, etc.).
 */
export function extractComments(cwd: string): HunkComment[] {
	try {
		const stdout = execSync(`hunk session comment list --repo ${JSON.stringify(cwd)} --json`, {
			cwd,
			encoding: "utf-8",
			timeout: 15_000,
			maxBuffer: 1024 * 1024,
		});
		return parseHunkComments(stdout);
	} catch {
		return [];
	}
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

/**
 * Launch an interactive `hunk patch -` review session.
 *
 * If the `hunk` CLI is not available, returns `{ available: false }`
 * immediately without throwing.
 *
 * Otherwise:
 *  1. Spawns `hunk patch -` in the given `cwd` with `diffRaw` piped to
 *     stdin while inheriting the parent process TTY (stdout / stderr).
 *  2. Waits for the subprocess to exit.
 *  3. Extracts any session comments left during the review via
 *     `hunk session comment list --repo <cwd> --json`.
 *
 * @returns A `HunkReviewResult` with availability flag and any comments.
 */
export async function launchHunkReview(cwd: string, diffRaw: string): Promise<HunkReviewResult> {
	const available = await checkHunkAvailable();
	if (!available) {
		return { available: false };
	}

	await new Promise<number | null>((resolve, reject) => {
		const proc = spawn("hunk", ["patch", "-"], {
			cwd,
			stdio: ["pipe", "inherit", "inherit"],
		});

		// Pipe the raw diff into the subprocess
		proc.stdin!.write(diffRaw);
		proc.stdin!.end();

		proc.on("close", resolve);
		proc.on("error", reject);
	});

	// Even when the exit code is non-zero we attempt to harvest comments
	// so the caller can still inspect partial review state.
	const comments = extractComments(cwd);

	return { available: true, comments };
}
