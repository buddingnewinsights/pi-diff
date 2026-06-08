import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";

import { codeToANSI } from "@shikijs/cli";
import * as Diff from "diff";
import type { BundledLanguage, BundledTheme } from "shiki";

import { getSepStyle, type ParsedDiff, sepLabelSplit, sepLabelUnified } from "../core/diff.js";
import { configIndicatorStyle } from "../core/config.js";
import type { ReviewHunk } from "./git.js";

export interface ReviewHunkPreviewInput {
	hunk: ReviewHunk;
	filePath: string;
	theme?: any;
	width: number;
	maxLines?: number;
}

export type ReviewHunkPreviewRenderer = (input: ReviewHunkPreviewInput) => Promise<string>;

interface DiffPreset {
	name: string;
	description: string;
	shikiTheme?: string;
	bgAdd?: string;
	bgDel?: string;
	bgAddHighlight?: string;
	bgDelHighlight?: string;
	bgGutterAdd?: string;
	bgGutterDel?: string;
	bgEmpty?: string;
	fgAdd?: string;
	fgDel?: string;
	fgDim?: string;
	fgLnum?: string;
	fgRule?: string;
	fgStripe?: string;
	fgSafeMuted?: string;
}

interface DiffUserConfig {
	diffTheme?: string;
	diffColors?: Record<string, string>;
}

interface DiffColors {
	fgAdd: string;
	fgDel: string;
	fgCtx: string;
}

const DIFF_PRESETS: Record<string, DiffPreset> = {
	default: {
		name: "default",
		description: "Original pi-diff colors — tuned for dark theme bases (~#1e1e2e)",
		bgAdd: "#162620",
		bgDel: "#2d1919",
		bgAddHighlight: "#234b32",
		bgDelHighlight: "#502323",
		bgGutterAdd: "#12201a",
		bgGutterDel: "#261616",
		bgEmpty: "#121212",
		fgDim: "#505050",
		fgLnum: "#646464",
		fgRule: "#323232",
		fgStripe: "#282828",
		fgSafeMuted: "#8b949e",
	},
	midnight: {
		name: "midnight",
		description: "Subtle tints for pure black (#000000) terminal backgrounds",
		bgAdd: "#0d1a12",
		bgDel: "#1a0d0d",
		bgAddHighlight: "#1a3825",
		bgDelHighlight: "#381a1a",
		bgGutterAdd: "#091208",
		bgGutterDel: "#120908",
		bgEmpty: "#080808",
		fgDim: "#404040",
		fgLnum: "#505050",
		fgRule: "#282828",
		fgStripe: "#1e1e1e",
		fgSafeMuted: "#8b949e",
	},
	subtle: {
		name: "subtle",
		description: "Minimal backgrounds — barely-there tints for a clean look",
		bgAdd: "#081008",
		bgDel: "#100808",
		bgAddHighlight: "#122818",
		bgDelHighlight: "#281212",
		bgGutterAdd: "#060c06",
		bgGutterDel: "#0c0606",
		bgEmpty: "#060606",
		fgDim: "#383838",
		fgLnum: "#484848",
		fgRule: "#242424",
		fgStripe: "#181818",
		fgSafeMuted: "#8b949e",
	},
	neon: {
		name: "neon",
		description: "Higher contrast backgrounds for better visibility",
		bgAdd: "#1a3320",
		bgDel: "#331a16",
		bgAddHighlight: "#2d5c3a",
		bgDelHighlight: "#5c2d2d",
		bgGutterAdd: "#142818",
		bgGutterDel: "#28120e",
		bgEmpty: "#141414",
		fgDim: "#606060",
		fgLnum: "#787878",
		fgRule: "#404040",
		fgStripe: "#303030",
		fgSafeMuted: "#9da5ae",
	},
};

const SPLIT_MIN_WIDTH = envInt("DIFF_SPLIT_MIN_WIDTH", 150);
const SPLIT_MIN_CODE_WIDTH = envInt("DIFF_SPLIT_MIN_CODE_WIDTH", 60);
const SPLIT_MAX_WRAP_RATIO = 0.2;
const SPLIT_MAX_WRAP_LINES = 8;
const MAX_HL_CHARS = 80_000;
const CACHE_LIMIT = 192;
const WORD_DIFF_MIN_SIM = 0.15;
const MAX_WRAP_ROWS_WIDE = 3;
const MAX_WRAP_ROWS_MED = 2;
const MAX_WRAP_ROWS_NARROW = 1;
const DEFAULT_RENDER_WIDTH = 120;
const MIN_RENDER_WIDTH = 40;

let RST = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
let BG_ADD = envBg("DIFF_BG_ADD", "\x1b[48;2;22;38;32m");
let BG_DEL = envBg("DIFF_BG_DEL", "\x1b[48;2;45;25;25m");
let BG_ADD_W = envBg("DIFF_BG_ADD_HL", "\x1b[48;2;35;75;50m");
let BG_DEL_W = envBg("DIFF_BG_DEL_HL", "\x1b[48;2;80;35;35m");
let BG_GUTTER_ADD = envBg("DIFF_BG_GUTTER_ADD", "\x1b[48;2;18;32;26m");
let BG_GUTTER_DEL = envBg("DIFF_BG_GUTTER_DEL", "\x1b[48;2;38;22;22m");
let BG_EMPTY = "\x1b[48;2;18;18;18m";
let FG_ADD = envFg("DIFF_FG_ADD", "\x1b[38;2;100;180;120m");
let FG_DEL = envFg("DIFF_FG_DEL", "\x1b[38;2;200;100;100m");
let FG_DIM = "\x1b[38;2;80;80;80m";
let FG_LNUM = "\x1b[38;2;100;100;100m";
let FG_RULE = "\x1b[38;2;50;50;50m";
let FG_SAFE_MUTED = "\x1b[38;2;139;148;158m";
let FG_STRIPE = "\x1b[38;2;40;40;40m";
function getBorderBar(): string {
	const style = configIndicatorStyle();
	return style === "none" ? " " : "▌";
}
let DIVIDER = `${FG_RULE}│${RST}`;
const ESC_RE = "\u001b";
const ANSI_RE = new RegExp(`${ESC_RE}\\[[0-9;]*m`, "g");
const ANSI_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([^m]*)m`, "g");
const ANSI_PARAM_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([0-9;]*)m`, "g");
const BG_DEFAULT = "\x1b[49m";
let BG_BASE = BG_DEFAULT;
let DEFAULT_DIFF_COLORS: DiffColors = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };
let _lastResolvedThemeKey = "";
let _autoDerivePending = true;
let _hasExplicitBgConfig = false;
let THEME: BundledTheme = (process.env.DIFF_THEME as BundledTheme | undefined) ?? "github-dark";
let paletteApplied = false;

const EXT_LANG: Record<string, BundledLanguage> = {
	ts: "typescript",
	tsx: "tsx",
	js: "javascript",
	jsx: "jsx",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	c: "c",
	cpp: "cpp",
	h: "c",
	hpp: "cpp",
	cs: "csharp",
	swift: "swift",
	kt: "kotlin",
	html: "html",
	css: "css",
	scss: "scss",
	json: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "toml",
	md: "markdown",
	sql: "sql",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	lua: "lua",
	php: "php",
	dart: "dart",
	xml: "xml",
	graphql: "graphql",
	svelte: "svelte",
	vue: "vue",
};

codeToANSI("", "typescript", THEME).catch(() => {});
const highlightCache = new Map<string, string[]>();

export async function renderReviewHunkPreview(input: ReviewHunkPreviewInput): Promise<string> {
	ensurePalette();
	const diff = createParsedDiffFromReviewHunk(input.hunk);
	const width = Math.max(MIN_RENDER_WIDTH, input.width || DEFAULT_RENDER_WIDTH);
	const language = lang(input.filePath);
	const colors = resolveDiffColors(input.theme);
	return renderUnified(diff, language, input.maxLines ?? diff.lines.length, colors, width);
}

function ensurePalette(): void {
	if (paletteApplied) return;
	applyDiffPalette();
	paletteApplied = true;
}

function createParsedDiffFromReviewHunk(hunk: ReviewHunk): ParsedDiff {
	let added = 0;
	let removed = 0;
	let chars = 0;
	for (const line of hunk.lines) {
		chars += line.content.length;
		if (line.type === "add") added += 1;
		if (line.type === "del") removed += 1;
	}
	return {
		lines: hunk.lines.map((line) => ({
			type: line.type,
			oldNum: line.oldNum,
			newNum: line.newNum,
			content: line.content,
		})),
		added,
		removed,
		chars,
	};
}

function envInt(name: string, fallback: number): number {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envFg(name: string, fallback: string): string {
	const hex = process.env[name];
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return fallback;
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

function envBg(name: string, fallback: string): string {
	const hex = process.env[name];
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return fallback;
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[48;2;${r};${g};${b}m`;
}

function parseAnsiRgb(ansi: string): { r: number; g: number; b: number } | null {
	const match = ansi.match(new RegExp(`${ESC_RE}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
	return match ? { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) } : null;
}

function hexToBgAnsi(hex: string): string {
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "";
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[48;2;${r};${g};${b}m`;
}

function hexToFgAnsi(hex: string): string {
	if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "";
	const r = Number.parseInt(hex.slice(1, 3), 16);
	const g = Number.parseInt(hex.slice(3, 5), 16);
	const b = Number.parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m`;
}

function mixBg(
	base: { r: number; g: number; b: number },
	accent: { r: number; g: number; b: number },
	intensity: number,
): string {
	const r = Math.round(base.r + (accent.r - base.r) * intensity);
	const g = Math.round(base.g + (accent.g - base.g) * intensity);
	const b = Math.round(base.b + (accent.b - base.b) * intensity);
	return `\x1b[48;2;${r};${g};${b}m`;
}

function autoDeriveBgFromTheme(theme: any): void {
	if (!theme?.getFgAnsi) return;
	try {
		const fgAdd = theme.getFgAnsi("toolDiffAdded");
		const fgDel = theme.getFgAnsi("toolDiffRemoved");
		const addRgb = parseAnsiRgb(fgAdd);
		const delRgb = parseAnsiRgb(fgDel);
		if (!addRgb || !delRgb) return;

		let addBase = { r: 0, g: 0, b: 0 };
		let delBase = addBase;
		if (theme.getBgAnsi) {
			try {
				const successBgAnsi = theme.getBgAnsi("toolSuccessBg");
				const successParsed = parseAnsiRgb(successBgAnsi);
				if (successParsed) {
					addBase = successParsed;
					delBase = successParsed;
					BG_BASE = successBgAnsi;
				}
			} catch {}
			try {
				const errorParsed = parseAnsiRgb(theme.getBgAnsi("toolErrorBg"));
				if (errorParsed) delBase = errorParsed;
			} catch {}
		}

		BG_ADD = mixBg(addBase, addRgb, 0.08);
		BG_DEL = mixBg(delBase, delRgb, 0.1);
		BG_ADD_W = mixBg(addBase, addRgb, 0.2);
		BG_DEL_W = mixBg(delBase, delRgb, 0.22);
		BG_GUTTER_ADD = mixBg(addBase, addRgb, 0.05);
		BG_GUTTER_DEL = mixBg(delBase, delRgb, 0.06);
		BG_EMPTY = BG_BASE;
		RST = `\x1b[0m${BG_BASE}`;
		DIVIDER = `${FG_RULE}│${RST}`;
	} catch {}
}

function loadDiffConfig(): DiffUserConfig {
	const paths = [`${process.cwd()}/.pi/settings.json`, `${process.env.HOME ?? ""}/.pi/settings.json`];
	for (const path of paths) {
		try {
			if (existsSync(path)) {
				const raw = JSON.parse(readFileSync(path, "utf-8"));
				if (raw.diffTheme || raw.diffColors) {
					return { diffTheme: raw.diffTheme, diffColors: raw.diffColors };
				}
			}
		} catch {}
	}
	return {};
}

export function applyDiffPalette(): void {
	const config = loadDiffConfig();
	const preset = config.diffTheme ? DIFF_PRESETS[config.diffTheme] : null;
	if (preset) _hasExplicitBgConfig = true;
	const overrides = config.diffColors ?? {};
	if (Object.keys(overrides).length > 0) _hasExplicitBgConfig = true;

	const applyBg = (
		envName: string | null,
		key: string,
		presetValue: string | undefined,
		set: (value: string) => void,
	) => {
		if (envName && process.env[envName]) return;
		const hex = overrides[key] ?? presetValue;
		if (hex) {
			const ansi = hexToBgAnsi(hex);
			if (ansi) set(ansi);
		}
	};
	const applyFg = (
		envName: string | null,
		key: string,
		presetValue: string | undefined,
		set: (value: string) => void,
	) => {
		if (envName && process.env[envName]) return;
		const hex = overrides[key] ?? presetValue;
		if (hex) {
			const ansi = hexToFgAnsi(hex);
			if (ansi) set(ansi);
		}
	};

	applyBg("DIFF_BG_ADD", "bgAdd", preset?.bgAdd, (value) => {
		BG_ADD = value;
	});
	applyBg("DIFF_BG_DEL", "bgDel", preset?.bgDel, (value) => {
		BG_DEL = value;
	});
	applyBg("DIFF_BG_ADD_HL", "bgAddHighlight", preset?.bgAddHighlight, (value) => {
		BG_ADD_W = value;
	});
	applyBg("DIFF_BG_DEL_HL", "bgDelHighlight", preset?.bgDelHighlight, (value) => {
		BG_DEL_W = value;
	});
	applyBg("DIFF_BG_GUTTER_ADD", "bgGutterAdd", preset?.bgGutterAdd, (value) => {
		BG_GUTTER_ADD = value;
	});
	applyBg("DIFF_BG_GUTTER_DEL", "bgGutterDel", preset?.bgGutterDel, (value) => {
		BG_GUTTER_DEL = value;
	});
	applyBg(null, "bgEmpty", preset?.bgEmpty, (value) => {
		BG_EMPTY = value;
	});
	applyFg("DIFF_FG_ADD", "fgAdd", preset?.fgAdd, (value) => {
		FG_ADD = value;
	});
	applyFg("DIFF_FG_DEL", "fgDel", preset?.fgDel, (value) => {
		FG_DEL = value;
	});
	applyFg(null, "fgDim", preset?.fgDim, (value) => {
		FG_DIM = value;
	});
	applyFg(null, "fgLnum", preset?.fgLnum, (value) => {
		FG_LNUM = value;
	});
	applyFg(null, "fgRule", preset?.fgRule, (value) => {
		FG_RULE = value;
	});
	applyFg(null, "fgStripe", preset?.fgStripe, (value) => {
		FG_STRIPE = value;
	});
	applyFg(null, "fgSafeMuted", preset?.fgSafeMuted, (value) => {
		FG_SAFE_MUTED = value;
	});
	const shikiTheme = overrides.shikiTheme ?? preset?.shikiTheme;
	if (shikiTheme) THEME = shikiTheme as BundledTheme;
	DIVIDER = `${FG_RULE}│${RST}`;
	DEFAULT_DIFF_COLORS = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };
	_autoDerivePending = !_hasExplicitBgConfig;
}

export function themeCacheKey(theme?: any): string {
	if (!theme?.fg) return "no-theme";
	const fgKeys = [
		"toolTitle",
		"accent",
		"muted",
		"success",
		"error",
		"toolDiffAdded",
		"toolDiffRemoved",
		"toolDiffContext",
	];
	const bgKeys = ["toolSuccessBg", "toolErrorBg"];
	const parts: string[] = [];
	for (const key of fgKeys) {
		try {
			parts.push(theme.fg(key, key));
		} catch {
			parts.push(key);
		}
	}
	for (const key of bgKeys) {
		try {
			parts.push(theme.bg ? theme.bg(key, key) : key);
		} catch {
			parts.push(key);
		}
	}
	return parts.join("|");
}

export function resolveDiffColors(theme?: any): DiffColors {
	const currentThemeKey = themeCacheKey(theme);
	if (!_hasExplicitBgConfig && _lastResolvedThemeKey && _lastResolvedThemeKey !== currentThemeKey) {
		BG_BASE = BG_DEFAULT;
		RST = "\x1b[0m";
		_autoDerivePending = true;
	}
	_lastResolvedThemeKey = currentThemeKey;
	if (theme?.getBgAnsi && BG_BASE === BG_DEFAULT) {
		try {
			const bgAnsi = theme.getBgAnsi("toolSuccessBg");
			const parsed = parseAnsiRgb(bgAnsi);
			if (parsed) {
				BG_BASE = bgAnsi;
				RST = `\x1b[0m${BG_BASE}`;
			}
		} catch {}
	}
	if (_autoDerivePending && theme?.getFgAnsi) {
		autoDeriveBgFromTheme(theme);
		_autoDerivePending = false;
	}
	if (!theme?.getFgAnsi) return DEFAULT_DIFF_COLORS;
	try {
		return {
			fgAdd: theme.getFgAnsi("toolDiffAdded") || FG_ADD,
			fgDel: theme.getFgAnsi("toolDiffRemoved") || FG_DEL,
			fgCtx: theme.getFgAnsi("toolDiffContext") || FG_DIM,
		};
	} catch {
		return DEFAULT_DIFF_COLORS;
	}
}

function strip(content: string): string {
	return content.replace(ANSI_RE, "");
}

function tabs(content: string): string {
	return content.replace(/\t/g, "  ");
}

function adaptiveWrapRows(width: number): number {
	if (width >= 180) return MAX_WRAP_ROWS_WIDE;
	if (width >= 120) return MAX_WRAP_ROWS_MED;
	return MAX_WRAP_ROWS_NARROW;
}

function fit(content: string, width: number): string {
	if (width <= 0) return "";
	const plain = strip(content);
	if (plain.length <= width) return content + " ".repeat(width - plain.length);
	const showWidth = width > 2 ? width - 1 : width;
	let visible = 0;
	let index = 0;
	while (index < content.length && visible < showWidth) {
		if (content[index] === "\x1b") {
			const end = content.indexOf("m", index);
			if (end !== -1) {
				index = end + 1;
				continue;
			}
		}
		visible += 1;
		index += 1;
	}
	return width > 2 ? `${content.slice(0, index)}${RST}${FG_DIM}›${RST}` : `${content.slice(0, index)}${RST}`;
}

function ansiState(content: string): string {
	let fg = "";
	let bg = "";
	for (const match of content.matchAll(ANSI_CAPTURE_RE)) {
		const params = match[1] ?? "";
		const sequence = match[0] ?? "";
		if (params === "0") {
			fg = "";
			bg = "";
		} else if (params === "39") {
			fg = "";
		} else if (params.startsWith("38;")) {
			fg = sequence;
		} else if (params.startsWith("48;")) {
			bg = sequence;
		}
	}
	return bg + fg;
}

function isLowContrastShikiFg(params: string): boolean {
	if (params === "30" || params === "90") return true;
	if (params === "38;5;0" || params === "38;5;8") return true;
	if (!params.startsWith("38;2;")) return false;
	const parts = params.split(";").map(Number);
	if (parts.length !== 5 || parts.some((value) => !Number.isFinite(value))) return false;
	const [, , r, g, b] = parts;
	const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luminance < 72;
}

function normalizeShikiContrast(ansi: string): string {
	return ansi.replace(ANSI_PARAM_CAPTURE_RE, (sequence, params: string) =>
		isLowContrastShikiFg(params) ? FG_SAFE_MUTED : sequence,
	);
}

function wrapAnsi(content: string, width: number, maxRows: number, fillBg = ""): string[] {
	if (width <= 0) return [""];
	const plain = strip(content);
	if (plain.length <= width) {
		const padding = width - plain.length;
		return padding > 0 ? [content + fillBg + " ".repeat(padding) + (fillBg ? RST : "")] : [content];
	}
	const rows: string[] = [];
	let row = "";
	let visible = 0;
	let index = 0;
	let onLastRow = false;
	let effectiveWidth = width;
	while (index < content.length) {
		if (!onLastRow && rows.length >= maxRows - 1) {
			onLastRow = true;
			effectiveWidth = width > 2 ? width - 1 : width;
		}
		if (content[index] === "\x1b") {
			const end = content.indexOf("m", index);
			if (end !== -1) {
				row += content.slice(index, end + 1);
				index = end + 1;
				continue;
			}
		}
		if (visible >= effectiveWidth) {
			if (onLastRow) {
				let hasMore = false;
				for (let cursor = index; cursor < content.length; cursor++) {
					if (content[cursor] === "\x1b") {
						const escapeEnd = content.indexOf("m", cursor);
						if (escapeEnd !== -1) {
							cursor = escapeEnd;
							continue;
						}
					}
					hasMore = true;
					break;
				}
				if (hasMore && width > 2) row += `${RST}${FG_DIM}›${RST}`;
				else row += fillBg + " ".repeat(Math.max(0, width - visible)) + RST;
				rows.push(row);
				return rows;
			}
			const state = ansiState(row);
			rows.push(row + RST);
			row = state + fillBg;
			visible = 0;
			if (rows.length >= maxRows - 1) {
				onLastRow = true;
				effectiveWidth = width > 2 ? width - 1 : width;
			}
		}
		row += content[index];
		visible += 1;
		index += 1;
	}
	if (row.length > 0 || rows.length === 0) {
		rows.push(row + fillBg + " ".repeat(Math.max(0, width - visible)) + RST);
	}
	return rows;
}

function lnum(value: number | null, width: number, fg = FG_LNUM): string {
	if (value === null) return " ".repeat(width);
	const text = String(value);
	return `${fg}${" ".repeat(Math.max(0, width - text.length))}${text}${RST}`;
}

function rule(width: number): string {
	return `${BG_BASE}${FG_RULE}${"─".repeat(width)}${RST}`;
}

function shouldUseSplit(diff: ParsedDiff, width: number, maxRows: number): boolean {
	if (!diff.lines.length) return false;
	if (width < SPLIT_MIN_WIDTH) return false;
	const numberWidth = Math.max(
		2,
		String(Math.max(...diff.lines.map((line) => line.oldNum ?? line.newNum ?? 0), 0)).length,
	);
	const half = Math.floor((width - 1) / 2);
	const gutterWidth = numberWidth + 5;
	const codeWidth = Math.max(12, half - gutterWidth);
	if (codeWidth < SPLIT_MIN_CODE_WIDTH) return false;
	const visibleLines = diff.lines.slice(0, maxRows);
	let contentLines = 0;
	let wrapCandidates = 0;
	for (const line of visibleLines) {
		if (line.type === "sep") continue;
		contentLines += 1;
		if (tabs(line.content).length > codeWidth) wrapCandidates += 1;
	}
	if (contentLines === 0) return true;
	const wrapRatio = wrapCandidates / contentLines;
	if (wrapCandidates >= SPLIT_MAX_WRAP_LINES) return false;
	if (wrapRatio >= SPLIT_MAX_WRAP_RATIO) return false;
	return true;
}

export function lang(filePath: string): BundledLanguage | undefined {
	return EXT_LANG[extname(filePath).slice(1).toLowerCase()];
}

function touchCache(key: string, value: string[]): string[] {
	highlightCache.delete(key);
	highlightCache.set(key, value);
	while (highlightCache.size > CACHE_LIMIT) {
		const first = highlightCache.keys().next().value;
		if (first === undefined) break;
		highlightCache.delete(first);
	}
	return value;
}

async function hlBlock(code: string, language: BundledLanguage | undefined): Promise<string[]> {
	if (!code) return [""];
	if (!language || code.length > MAX_HL_CHARS) return code.split("\n");
	const key = `${THEME}\0${language}\0${code}`;
	const cached = highlightCache.get(key);
	if (cached) return touchCache(key, cached);
	try {
		const ansi = normalizeShikiContrast(await codeToANSI(code, language, THEME));
		const output = (ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi).split("\n");
		return touchCache(key, output);
	} catch {
		return code.split("\n");
	}
}

function wordDiffAnalysis(
	oldText: string,
	newText: string,
): {
	similarity: number;
	oldRanges: Array<[number, number]>;
	newRanges: Array<[number, number]>;
} {
	if (!oldText && !newText) return { similarity: 1, oldRanges: [], newRanges: [] };
	const parts = Diff.diffWords(oldText, newText);
	const oldRanges: Array<[number, number]> = [];
	const newRanges: Array<[number, number]> = [];
	let oldPosition = 0;
	let newPosition = 0;
	let same = 0;
	for (const part of parts) {
		if (part.removed) {
			oldRanges.push([oldPosition, oldPosition + part.value.length]);
			oldPosition += part.value.length;
		} else if (part.added) {
			newRanges.push([newPosition, newPosition + part.value.length]);
			newPosition += part.value.length;
		} else {
			const length = part.value.length;
			same += length;
			oldPosition += length;
			newPosition += length;
		}
	}
	const maxLength = Math.max(oldText.length, newText.length);
	return { similarity: maxLength > 0 ? same / maxLength : 1, oldRanges, newRanges };
}

function injectBg(ansiLine: string, ranges: Array<[number, number]>, baseBg: string, highlightBg: string): string {
	if (!ranges.length) return baseBg + ansiLine + RST;
	let output = baseBg;
	let visible = 0;
	let inHighlight = false;
	let rangeIndex = 0;
	let index = 0;
	while (index < ansiLine.length) {
		if (ansiLine[index] === "\x1b") {
			const end = ansiLine.indexOf("m", index);
			if (end !== -1) {
				const sequence = ansiLine.slice(index, end + 1);
				output += sequence;
				// Re-inject bg after any reset-like sequence (Shiki uses \x1b[39m
				// between tokens; some terminals may treat it as a broader reset).
				if (sequence === "\x1b[0m" || sequence === "\x1b[39m" || sequence === "\x1b[49m") {
					output += inHighlight ? highlightBg : baseBg;
				}
				index = end + 1;
				continue;
			}
		}
		while (rangeIndex < ranges.length && visible >= ranges[rangeIndex][1]) rangeIndex += 1;
		const wantsHighlight =
			rangeIndex < ranges.length && visible >= ranges[rangeIndex][0] && visible < ranges[rangeIndex][1];
		if (wantsHighlight !== inHighlight) {
			inHighlight = wantsHighlight;
			output += inHighlight ? highlightBg : baseBg;
		}
		output += ansiLine[index];
		visible += 1;
		index += 1;
	}
	return output + RST;
}

function plainWordDiff(oldText: string, newText: string): { old: string; new: string } {
	const parts = Diff.diffWords(oldText, newText);
	let oldOutput = "";
	let newOutput = "";
	for (const part of parts) {
		if (part.removed) oldOutput += `${BG_DEL_W}${part.value}${RST}${BG_DEL}`;
		else if (part.added) newOutput += `${BG_ADD_W}${part.value}${RST}${BG_ADD}`;
		else {
			oldOutput += part.value;
			newOutput += part.value;
		}
	}
	return { old: oldOutput, new: newOutput };
}

export async function renderUnified(
	diff: ParsedDiff,
	language: BundledLanguage | undefined,
	maxLines: number,
	colors: DiffColors,
	width: number,
): Promise<string> {
	if (!diff.lines.length) return "";
	const visible = diff.lines.slice(0, maxLines);
	const renderWidth = Math.max(MIN_RENDER_WIDTH, width);
	const numberWidth = Math.max(
		2,
		String(Math.max(...visible.map((line) => line.oldNum ?? line.newNum ?? 0), 0)).length,
	);
	const gutterWidth = numberWidth + 5;
	const codeWidth = Math.max(20, renderWidth - gutterWidth);
	const canHighlight = diff.chars <= MAX_HL_CHARS && visible.length <= maxLines;

	const oldSource: string[] = [];
	const newSource: string[] = [];
	for (const line of visible) {
		if (line.type === "ctx" || line.type === "del") oldSource.push(line.content);
		if (line.type === "ctx" || line.type === "add") newSource.push(line.content);
	}
	const [oldHighlights, newHighlights] = canHighlight
		? await Promise.all([hlBlock(oldSource.join("\n"), language), hlBlock(newSource.join("\n"), language)])
		: [oldSource, newSource];

	let oldIndex = 0;
	let newIndex = 0;
	let index = 0;
	const output: string[] = [rule(renderWidth)];

	function emitRow(
		number: number | null,
		sign: string,
		gutterBg: string,
		signFg: string,
		body: string,
		bodyBg = "",
	): void {
		const borderFg = sign === "-" ? colors.fgDel : sign === "+" ? colors.fgAdd : "";
		const border = borderFg ? `${borderFg}${getBorderBar()}${RST}` : `${BG_BASE} `;
		const numFg = borderFg || FG_LNUM;
		const gutter = `${border}${gutterBg}${lnum(number, numberWidth, numFg)}${signFg}${sign}${RST} ${DIVIDER} `;
		const continuationGutter = `${border}${gutterBg}${" ".repeat(numberWidth + 1)}${RST} ${DIVIDER} `;
		const rows = wrapAnsi(tabs(body), codeWidth, adaptiveWrapRows(renderWidth), bodyBg);
		output.push(`${gutter}${rows[0]}${RST}`);
		for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
			output.push(`${continuationGutter}${rows[rowIndex]}${RST}`);
		}
	}

	while (index < visible.length) {
		const line = visible[index];
		if (line.type === "sep") {
			const label = sepLabelUnified(getSepStyle(), line.hunkMeta, line.newNum, line.content);
			const totalWidth = Math.min(renderWidth, 72);
			const padding = Math.max(0, totalWidth - label.length - 2);
			const left = Math.floor(padding / 2);
			const right = padding - left;
			output.push(`${BG_BASE}${FG_DIM}${"─".repeat(left)}${label}${"─".repeat(right)}${RST}`);
			index += 1;
			continue;
		}
		if (line.type === "ctx") {
			const highlight = oldHighlights[oldIndex] ?? line.content;
			emitRow(line.newNum, " ", BG_BASE, colors.fgCtx, `${BG_BASE}${DIM}${highlight}`, BG_BASE);
			oldIndex += 1;
			newIndex += 1;
			index += 1;
			continue;
		}

		const deletions: Array<{ line: ParsedDiff["lines"][number]; hl: string }> = [];
		while (index < visible.length && visible[index].type === "del") {
			deletions.push({ line: visible[index], hl: oldHighlights[oldIndex] ?? visible[index].content });
			oldIndex += 1;
			index += 1;
		}
		const additions: Array<{ line: ParsedDiff["lines"][number]; hl: string }> = [];
		while (index < visible.length && visible[index].type === "add") {
			additions.push({ line: visible[index], hl: newHighlights[newIndex] ?? visible[index].content });
			newIndex += 1;
			index += 1;
		}

		const isPaired = deletions.length === 1 && additions.length === 1;
		const wordDiff = isPaired ? wordDiffAnalysis(deletions[0].line.content, additions[0].line.content) : null;
		const wordDiffBalanced = wordDiff && wordDiff.oldRanges.length > 0 && wordDiff.newRanges.length > 0;
		if (isPaired && wordDiffBalanced && wordDiff.similarity >= WORD_DIFF_MIN_SIM && canHighlight) {
			const deletionBody = injectBg(deletions[0].hl, wordDiff.oldRanges, BG_DEL, BG_DEL_W);
			const additionBody = injectBg(additions[0].hl, wordDiff.newRanges, BG_ADD, BG_ADD_W);
			emitRow(deletions[0].line.oldNum, "-", BG_GUTTER_DEL, `${colors.fgDel}${BOLD}`, deletionBody, BG_DEL);
			emitRow(additions[0].line.newNum, "+", BG_GUTTER_ADD, `${colors.fgAdd}${BOLD}`, additionBody, BG_ADD);
			continue;
		}
		if (isPaired && wordDiffBalanced && wordDiff.similarity >= WORD_DIFF_MIN_SIM && !canHighlight) {
			const plain = plainWordDiff(deletions[0].line.content, additions[0].line.content);
			emitRow(deletions[0].line.oldNum, "-", BG_GUTTER_DEL, `${colors.fgDel}${BOLD}`, `${BG_DEL}${plain.old}`, BG_DEL);
			emitRow(additions[0].line.newNum, "+", BG_GUTTER_ADD, `${colors.fgAdd}${BOLD}`, `${BG_ADD}${plain.new}`, BG_ADD);
			continue;
		}
		for (const deletion of deletions) {
			const body = canHighlight ? `${BG_DEL}${deletion.hl}` : `${BG_DEL}${deletion.line.content}`;
			emitRow(deletion.line.oldNum, "-", BG_GUTTER_DEL, `${colors.fgDel}${BOLD}`, body, BG_DEL);
		}
		for (const addition of additions) {
			const body = canHighlight ? `${BG_ADD}${addition.hl}` : `${BG_ADD}${addition.line.content}`;
			emitRow(addition.line.newNum, "+", BG_GUTTER_ADD, `${colors.fgAdd}${BOLD}`, body, BG_ADD);
		}
	}

	output.push(rule(renderWidth));
	if (diff.lines.length > visible.length) {
		output.push(`${BG_BASE}${FG_DIM}  … ${diff.lines.length - visible.length} more lines${RST}`);
	}
	return output.join("\n");
}

export async function renderSplit(
	diff: ParsedDiff,
	language: BundledLanguage | undefined,
	maxLines: number,
	colors: DiffColors,
	width: number,
): Promise<string> {
	if (!shouldUseSplit(diff, width, maxLines)) return renderUnified(diff, language, maxLines, colors, width);
	if (!diff.lines.length) return "";

	// Build rows — process ctx/sep individually, group del/add blocks
	type Row = { left: ParsedDiff["lines"][number] | null; right: ParsedDiff["lines"][number] | null };
	const rows: Row[] = [];
	let idx = 0;
	while (idx < diff.lines.length) {
		const line = diff.lines[idx];
		if (line.type === "ctx") {
			rows.push({ left: line, right: line });
			idx++;
			continue;
		}
		if (line.type === "sep") {
			rows.push({ left: line, right: line });
			idx++;
			continue;
		}
		// Collect del/add block
		const dels: ParsedDiff["lines"] = [];
		while (idx < diff.lines.length && diff.lines[idx]?.type === "del") {
			const dl = diff.lines[idx];
			if (dl) dels.push(dl);
			idx++;
		}
		const adds: ParsedDiff["lines"] = [];
		while (idx < diff.lines.length && diff.lines[idx]?.type === "add") {
			const al = diff.lines[idx];
			if (al) adds.push(al);
			idx++;
		}
		const count = Math.max(dels.length, adds.length);
		for (let r = 0; r < count; r++)
			rows.push({ left: dels[r] ?? null, right: adds[r] ?? null });
	}

	const visible = rows.slice(0, maxLines);
	const renderWidth = Math.max(MIN_RENDER_WIDTH, width);
	const half = Math.floor((renderWidth - 1) / 2);
	const numberWidth = Math.max(
		2,
		String(Math.max(...diff.lines.map((line) => line.oldNum ?? line.newNum ?? 0), 0)).length,
	);
	const gutterWidth = numberWidth + 5;
	const codeWidth = Math.max(12, half - gutterWidth);
	const canHighlight = diff.chars <= MAX_HL_CHARS && visible.length * 2 <= maxLines * 2;

	const leftSource: string[] = [];
	const rightSource: string[] = [];
	for (const row of visible) {
		if (row.left && row.left.type !== "sep") leftSource.push(row.left.content);
		if (row.right && row.right.type !== "sep") rightSource.push(row.right.content);
	}
	const [leftHighlights, rightHighlights] = canHighlight
		? await Promise.all([hlBlock(leftSource.join("\n"), language), hlBlock(rightSource.join("\n"), language)])
		: [leftSource, rightSource];

	let leftIndex = 0;
	let rightIndex = 0;
	const output: string[] = [];
	output.push(`${rule(half)}${FG_RULE}┊${RST}${rule(half)}`);

	type HalfResult = { gutter: string; continuation: string; bodyRows: string[] };
	const emptyBody = `${BG_EMPTY}${" ".repeat(codeWidth)}${RST}`;

	function buildHalf(
		line: ParsedDiff["lines"][number] | null,
		highlight: string,
		ranges: Array<[number, number]> | null,
		side: "left" | "right",
	): HalfResult {
		if (!line) {
			const gutter = `${BG_BASE} ${" ".repeat(numberWidth + 2)}${FG_RULE}│${RST} `;
			return { gutter, continuation: gutter, bodyRows: [emptyBody] };
		}
		if (line.type === "sep") {
			const label = sepLabelSplit(getSepStyle(), line.hunkMeta, line.newNum, line.content);
			const gutter = `${BG_BASE} ${FG_DIM}${fit("", numberWidth + 2)}${RST}${FG_RULE}│${RST} `;
			return { gutter, continuation: gutter, bodyRows: [`${BG_BASE}${FG_DIM}${fit(label, codeWidth)}${RST}`] };
		}
		const isDeletion = line.type === "del";
		const isAddition = line.type === "add";
		const gutterBg = isDeletion ? BG_GUTTER_DEL : isAddition ? BG_GUTTER_ADD : BG_BASE;
		const codeBg = isDeletion ? BG_DEL : isAddition ? BG_ADD : BG_BASE;
		const signFg = isDeletion ? colors.fgDel : isAddition ? colors.fgAdd : colors.fgCtx;
		const sign = isDeletion ? "-" : isAddition ? "+" : " ";
		const number = isDeletion ? line.oldNum : isAddition ? line.newNum : side === "left" ? line.oldNum : line.newNum;
		const borderFg = isDeletion ? colors.fgDel : isAddition ? colors.fgAdd : "";
		const border = borderFg ? `${borderFg}${getBorderBar()}${RST}` : `${BG_BASE} `;
		const numFg = borderFg || FG_LNUM;
		let body = isDeletion || isAddition ? `${codeBg}${highlight}` : `${BG_BASE}${DIM}${highlight}`;
		if (ranges && ranges.length > 0) body = injectBg(highlight, ranges, codeBg, isDeletion ? BG_DEL_W : BG_ADD_W);
		const gutter = `${border}${gutterBg}${lnum(number, numberWidth, numFg)}${signFg}${BOLD}${sign}${RST} ${FG_RULE}│${RST} `;
		const continuation = `${border}${gutterBg}${" ".repeat(numberWidth + 1)}${RST} ${FG_RULE}│${RST} `;
		return { gutter, continuation, bodyRows: wrapAnsi(tabs(body), codeWidth, adaptiveWrapRows(renderWidth), codeBg) };
	}

	for (const row of visible) {
		const isPairedChange = row.left?.type === "del" && row.right?.type === "add";
		const wordDiff =
			isPairedChange && row.left && row.right ? wordDiffAnalysis(row.left.content, row.right.content) : null;
		const wordDiffBalanced =
			wordDiff && wordDiff.oldRanges.length > 0 && wordDiff.newRanges.length > 0;
		const leftHighlight = row.left && row.left.type !== "sep" ? (leftHighlights[leftIndex++] ?? row.left.content) : "";
		const rightHighlight =
			row.right && row.right.type !== "sep" ? (rightHighlights[rightIndex++] ?? row.right.content) : "";
		const leftHalf = buildHalf(
			row.left,
			leftHighlight,
			isPairedChange && wordDiffBalanced && wordDiff.similarity >= WORD_DIFF_MIN_SIM ? wordDiff.oldRanges : null,
			"left",
		);
		const rightHalf = buildHalf(
			row.right,
			rightHighlight,
			isPairedChange && wordDiffBalanced && wordDiff.similarity >= WORD_DIFF_MIN_SIM ? wordDiff.newRanges : null,
			"right",
		);
		const maxRows = Math.max(leftHalf.bodyRows.length, rightHalf.bodyRows.length);
		for (let rowIndex = 0; rowIndex < maxRows; rowIndex++) {
			const leftBody = leftHalf.bodyRows[rowIndex] ?? emptyBody;
			const rightBody = rightHalf.bodyRows[rowIndex] ?? emptyBody;
			output.push(
				`${rowIndex === 0 ? leftHalf.gutter : leftHalf.continuation}${leftBody}${DIVIDER}${rowIndex === 0 ? rightHalf.gutter : rightHalf.continuation}${rightBody}`,
			);
		}
	}

	output.push(`${rule(half)}${FG_RULE}┊${RST}${rule(half)}`);
	if (rows.length > visible.length)
		output.push(`${BG_BASE}${FG_DIM}  … ${rows.length - visible.length} more lines${RST}`);
	return output.join("\n");
}
