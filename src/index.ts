/**
 * pi-diff — Shiki-powered terminal diff renderer for pi.
 *
 * @module pi-diff
 * @see https://github.com/buddingnewinsights/pi-diff
 *
 * Architecture (like OpenTUI / delta):
 *   1. Syntax-highlight full code blocks via Shiki → ANSI (fg-only codes)
 *   2. Layer diff background colors underneath (composites at cell level)
 *   3. For word-level changes, inject brighter bg at changed char positions
 *   4. Result: syntax fg + diff bg + word emphasis — all three visible together
 *
 * Views:
 *   • Split (side-by-side) — edit tool, auto-falls back to unified on narrow terminals
 *   • Unified (stacked)    — write tool overwrites
 *
 * Performance:
 *   • Singleton Shiki highlighter (managed by @shikijs/cli)
 *   • LRU memo cache per highlighted block
 *   • Large-diff fallback (skip highlighting, still show diff)
 *   • Async rendering with invalidate() for non-blocking preview
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { codeToANSI } from "@shikijs/cli";
import * as Diff from "diff";
import { configIndicatorStyle } from "./core/config.js";
import {
  computeHunkBlocks,
  type DiffLine,
  getSepStyle,
  type ParsedDiff,
  parseDiff,
  parsePatchFiles,
  resolveSepStyle,
  sepLabelSplit,
  sepLabelUnified,
} from "./core/diff.js";
    import { replace } from "./core/replace.js";

import {
  applyDiffPalette as applySharedDiffPalette,
  lang as detectDiffLanguage,
  renderSplit as renderSharedSplit,
  resolveDiffColors as resolveSharedDiffColors,
  themeCacheKey as sharedThemeCacheKey,
} from "./review/hunk-preview.js";

type BundledLanguage = Parameters<typeof codeToANSI>[1];
type BundledTheme = Parameters<typeof codeToANSI>[2];

/** Simplified Pi theme — only methods pi-diff actually calls. */
interface PiTheme {
  fg(name: string, text: string): string;
  getFgAnsi?(name: string): string;
  getBgAnsi?(name: string): string;
  bg?(name: string, text: string): string;
  bold(text: string): string;
}

// ---------------------------------------------------------------------------
// Diff Theme System — presets, auto-derive, and per-color overrides
//
// Resolution chain (per color, highest priority first):
//   1. Environment variable override (e.g. DIFF_BG_ADD="#1a3320")
//   2. diffColors.bgAdd from .pi/settings.json (explicit per-color hex)
//   3. diffTheme preset value (named preset like "midnight")
//   4. Auto-derived from pi theme fg colors (default behavior)
//   5. Hardcoded fallback
// ---------------------------------------------------------------------------

/** Hex color palette for a diff theme preset. All values "#RRGGBB". */
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

/** User diff config read from .pi/settings.json */
interface DiffUserConfig {
  diffTheme?: string;
  diffColors?: Record<string, string>;
}

const DIFF_PRESETS: Record<string, DiffPreset> = {
  default: {
    name: "default",
    description: "Original pi-diff colors — tuned for dark theme bases (~#1e1e2e)",
    bgAdd: "#1a3324",
    bgDel: "#3d2020",
    bgAddHighlight: "#2d5c3a",
    bgDelHighlight: "#5c2d2d",
    bgGutterAdd: "#16281e",
    bgGutterDel: "#301c1c",
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
    bgAdd: "#101e15",
    bgDel: "#1e1010",
    bgAddHighlight: "#1a3825",
    bgDelHighlight: "#381a1a",
    bgGutterAdd: "#0c180c",
    bgGutterDel: "#180c0c",
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
    bgAdd: "#0c160c",
    bgDel: "#160c0c",
    bgAddHighlight: "#122818",
    bgDelHighlight: "#281212",
    bgGutterAdd: "#080e08",
    bgGutterDel: "#0e0808",
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
    bgAdd: "#1e3a28",
    bgDel: "#3a1c18",
    bgAddHighlight: "#2d5c3a",
    bgDelHighlight: "#5c2d2d",
    bgGutterAdd: "#182c1c",
    bgGutterDel: "#2c1410",
    bgEmpty: "#141414",
    fgDim: "#606060",
    fgLnum: "#787878",
    fgRule: "#404040",
    fgStripe: "#303030",
    fgSafeMuted: "#9da5ae",
  },
};

/** Parse 24-bit ANSI color code → RGB. Works for both fg and bg escapes. */
function parseAnsiRgb(ansi: string): { r: number; g: number; b: number } | null {
  const esc = "\u001b";
  const m = ansi.match(new RegExp(`${esc}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
  return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
}

/** Convert "#RRGGBB" hex → ANSI 24-bit background escape. */
function hexToBgAnsi(hex: string): string {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "";
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/** Convert "#RRGGBB" hex → ANSI 24-bit foreground escape. */
function hexToFgAnsi(hex: string): string {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex)) return "";
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** Derive a muted background ANSI code from a foreground ANSI code.
 *  Scales the fg RGB by `intensity` (0.0–1.0) to produce a subtle tint. */
function deriveBgFromFg(fgAnsi: string, intensity: number): string {
  const rgb = parseAnsiRgb(fgAnsi);
  if (!rgb) return "";
  const r = Math.round(rgb.r * intensity);
  const g = Math.round(rgb.g * intensity);
  const b = Math.round(rgb.b * intensity);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/** Mix an accent color into a base color at the given intensity (0.0–1.0).
 *  Returns an ANSI 24-bit background escape. Used to derive diff backgrounds
 *  that blend with the tool box background (toolSuccessBg). */
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

/** Whether auto-derive from theme is still pending (runs lazily on first render). */
let _autoDerivePending = true;

/** Whether user set explicit bg config (via preset or per-color overrides). */
let _hasExplicitBgConfig = false;

/** Auto-derive all diff background colors from the pi theme's fg diff colors.
 *  Reads toolSuccessBg as the add/context base and toolErrorBg as the delete base,
 *  then mixes accent colors into each. Falls back to black (0,0,0) when a theme
 *  background is unavailable; toolErrorBg falls back to toolSuccessBg. */
function autoDeriveBgFromTheme(theme: PiTheme): void {
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
      } catch {
        /* no toolSuccessBg — use black */
      }

      try {
        const errorParsed = parseAnsiRgb(theme.getBgAnsi("toolErrorBg"));
        if (errorParsed) delBase = errorParsed;
      } catch {
        /* no toolErrorBg — use toolSuccessBg/black */
      }
    }

    // Line backgrounds — visible accent mixed into the matching tool-state base (15–18%)
    BG_ADD = mixBg(addBase, addRgb, 0.15);
    BG_DEL = mixBg(delBase, delRgb, 0.18);

    // Word-level highlights — more prominent (30–35%)
    BG_ADD_W = mixBg(addBase, addRgb, 0.3);
    BG_DEL_W = mixBg(delBase, delRgb, 0.35);

    // Gutters — slightly subtler than lines (10–12%)
    BG_GUTTER_ADD = mixBg(addBase, addRgb, 0.1);
    BG_GUTTER_DEL = mixBg(delBase, delRgb, 0.12);

    // Empty filler and context — match the success/context base
    BG_EMPTY = BG_BASE;

    // Update RST to re-apply base bg after every reset — prevents black
    // flashes between styled segments when toolSuccessBg is non-black
    RST = `\x1b[0m${BG_BASE}`;

        // Rebuild derived constants
        DIVIDER = `${FG_RULE}${RST}`;
  } catch {
    // Fall back to defaults silently
  }
}

/** Load diff theme config from .pi/settings.json (project-level, then global). */
function loadDiffConfig(): DiffUserConfig {
  const paths = [
    `${process.cwd()}/.pi/settings.json`,
    `${process.env.HOME ?? ""}/.pi/settings.json`,
  ];
  for (const p of paths) {
    try {
      if (existsSync(p)) {
        const raw = JSON.parse(readFileSync(p, "utf-8"));
        if (raw.diffTheme || raw.diffColors) {
          return { diffTheme: raw.diffTheme, diffColors: raw.diffColors };
        }
      }
    } catch {
      // skip invalid files
    }
  }
  return {};
}

/** Apply diff palette from settings → preset → (auto-derive deferred) → defaults.
 *  Called once during extension initialization. */
function applyDiffPalette(): void {
  const config = loadDiffConfig();

  // Load preset if specified
  const preset = config.diffTheme ? DIFF_PRESETS[config.diffTheme] : null;
  if (preset) _hasExplicitBgConfig = true;

  // Per-color overrides from settings
  const ov = config.diffColors ?? {};
  if (Object.keys(ov).length > 0) _hasExplicitBgConfig = true;

  // Helper: apply a hex bg color if not env-overridden
  const applyBg = (
    envName: string | null,
    key: string,
    presetVal: string | undefined,
    set: (v: string) => void,
  ) => {
    if (envName && process.env[envName]) return; // env override wins
    const hex = ov[key] ?? presetVal;
    if (hex) {
      const a = hexToBgAnsi(hex);
      if (a) set(a);
    }
  };
  // Helper: apply a hex fg color if not env-overridden
  const applyFg = (
    envName: string | null,
    key: string,
    presetVal: string | undefined,
    set: (v: string) => void,
  ) => {
    if (envName && process.env[envName]) return;
    const hex = ov[key] ?? presetVal;
    if (hex) {
      const a = hexToFgAnsi(hex);
      if (a) set(a);
    }
  };

  // --- Apply backgrounds ---
  applyBg("DIFF_BG_ADD", "bgAdd", preset?.bgAdd, (v) => {
    BG_ADD = v;
  });
  applyBg("DIFF_BG_DEL", "bgDel", preset?.bgDel, (v) => {
    BG_DEL = v;
  });
  applyBg("DIFF_BG_ADD_HL", "bgAddHighlight", preset?.bgAddHighlight, (v) => {
    BG_ADD_W = v;
  });
  applyBg("DIFF_BG_DEL_HL", "bgDelHighlight", preset?.bgDelHighlight, (v) => {
    BG_DEL_W = v;
  });
  applyBg("DIFF_BG_GUTTER_ADD", "bgGutterAdd", preset?.bgGutterAdd, (v) => {
    BG_GUTTER_ADD = v;
  });
  applyBg("DIFF_BG_GUTTER_DEL", "bgGutterDel", preset?.bgGutterDel, (v) => {
    BG_GUTTER_DEL = v;
  });
  applyBg(null, "bgEmpty", preset?.bgEmpty, (v) => {
    BG_EMPTY = v;
  });

  // --- Apply foregrounds ---
  applyFg("DIFF_FG_ADD", "fgAdd", preset?.fgAdd, (v) => {
    FG_ADD = v;
  });
  applyFg("DIFF_FG_DEL", "fgDel", preset?.fgDel, (v) => {
    FG_DEL = v;
  });
  applyFg(null, "fgDim", preset?.fgDim, (v) => {
    FG_DIM = v;
  });
  applyFg(null, "fgLnum", preset?.fgLnum, (v) => {
    FG_LNUM = v;
  });
  applyFg(null, "fgRule", preset?.fgRule, (v) => {
    FG_RULE = v;
  });
  applyFg(null, "fgStripe", preset?.fgStripe, (v) => {
    FG_STRIPE = v;
  });
  applyFg(null, "fgSafeMuted", preset?.fgSafeMuted, (v) => {
    FG_SAFE_MUTED = v;
  });

  // --- Shiki syntax theme ---
  const shiki = ov.shikiTheme ?? preset?.shikiTheme;
  if (shiki) THEME = shiki as BundledTheme;

  // --- Rebuild derived constants ---
  DIVIDER = `${FG_RULE}${RST}`;
  DEFAULT_DIFF_COLORS = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };

  // If no explicit bg config, auto-derive will run on first render
  _autoDerivePending = !_hasExplicitBgConfig;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

let THEME: BundledTheme = (process.env.DIFF_THEME as BundledTheme | undefined) ?? "github-dark";

function envInt(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** Parse env hex color "#RRGGBB" → ANSI 24-bit fg/bg escape, or return fallback. */
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

// --- Split-view thresholds ---
// Split is preferred when there's real room. At narrow widths, a clean stacked
// (unified) view is better than a cramped split with wrapping.
const SPLIT_MIN_WIDTH = envInt("DIFF_SPLIT_MIN_WIDTH", 80); // allow split in normal terminals
const SPLIT_MIN_CODE_WIDTH = envInt("DIFF_SPLIT_MIN_CODE_WIDTH", 24); // short balanced hunks can split
const SPLIT_MAX_WRAP_RATIO = 0.35; // wrap-heavy hunks fall back to unified
const SPLIT_MAX_WRAP_LINES = 10; // absolute cap before unified fallback

// --- Terminal bounds ---
const MAX_TERM_WIDTH = 210; // max for 1728px wide display (~205 cols at typical font)
const DEFAULT_TERM_WIDTH = 200; // safe default for 1728x1117 resolution

// --- Rendering limits ---
const MAX_PREVIEW_LINES = 60; // was 50 — show slightly more context in edit preview
const MAX_RENDER_LINES = 150; // was 120 — show more of the diff in write tool
const MAX_HL_CHARS = 80_000; // was 50k — allow syntax hl for larger diffs
const CACHE_LIMIT = 192; // was 128 — bigger cache for multi-file sessions

// --- Word diff ---
const WORD_DIFF_MIN_SIM = 0.15; // was 0.2 — show word diffs for slightly less similar lines

// --- Wrapping ---
// Adaptive: narrow terminals truncate aggressively, wide terminals allow wrapping.
// Actual wrap rows are computed per-render via adaptiveWrapRows().
const MAX_WRAP_ROWS_WIDE = 3; // ≥180 cols
const MAX_WRAP_ROWS_MED = 2; // 120–179 cols
const MAX_WRAP_ROWS_NARROW = 1; // <120 cols (truncate, no wrap)

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------

let RST = "\x1b[0m";
const DIM = "\x1b[2m";

// Subtle diff backgrounds — muted tones to let syntax fg shine through
// Override via env: DIFF_BG_ADD="#1a3320" etc. (hex "#RRGGBB" format)
let BG_ADD = envBg("DIFF_BG_ADD", "\x1b[48;2;30;52;40m"); // visible teal-green
let BG_DEL = envBg("DIFF_BG_DEL", "\x1b[48;2;60;30;30m"); // visible brown-red
let BG_ADD_W = envBg("DIFF_BG_ADD_HL", "\x1b[48;2;45;90;60m"); // word-level emphasis
let BG_DEL_W = envBg("DIFF_BG_DEL_HL", "\x1b[48;2;100;45;45m");
let BG_GUTTER_ADD = envBg("DIFF_BG_GUTTER_ADD", "\x1b[48;2;24;42;32m");
let BG_GUTTER_DEL = envBg("DIFF_BG_GUTTER_DEL", "\x1b[48;2;48;28;28m");
const BG_GUTTER_CTX = ""; // use terminal default bg for context gutters
let BG_EMPTY = "\x1b[48;2;18;18;18m"; // filler rows when one side is shorter

// Diff foregrounds — override via env: DIFF_FG_ADD="#50d264" etc.
let FG_ADD = envFg("DIFF_FG_ADD", "\x1b[38;2;100;180;120m"); // desaturated green
let FG_DEL = envFg("DIFF_FG_DEL", "\x1b[38;2;200;100;100m"); // desaturated red
let FG_DIM = "\x1b[38;2;80;80;80m";
let FG_LNUM = "\x1b[38;2;100;100;100m";
let FG_RULE = "\x1b[38;2;50;50;50m";
let FG_SAFE_MUTED = "\x1b[38;2;139;148;158m";

let FG_STRIPE = "\x1b[38;2;40;40;40m"; // gray diagonal stripes on terminal default bg

function getBorderBar(): string {
  const style = configIndicatorStyle();
  return style === "none" ? " " : "▌";
}

/** Generate a dense diagonal stripe fill for empty filler cells.
 *  Solid ╱ characters — uniform direction like CSS diagonal hatching. */
function stripes(w: number, _rowOffset: number): string {
  return BG_BASE + FG_STRIPE + "╱".repeat(w) + RST;
}

let DIVIDER = `${FG_RULE}${RST}`;
const ESC_RE = "\u001b";
const ANSI_RE = new RegExp(`${ESC_RE}\\[[0-9;]*m`, "g");
const ANSI_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([^m]*)m`, "g");
const ANSI_PARAM_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([0-9;]*)m`, "g");
const BG_DEFAULT = "\x1b[49m"; // reset to terminal default background
let BG_BASE = BG_DEFAULT; // tool box base bg — updated from theme's toolSuccessBg

// ---------------------------------------------------------------------------
// Theme-aware diff colors
// ---------------------------------------------------------------------------

/** Resolved ANSI colors for diff rendering — theme overrides hardcoded defaults. */
interface DiffColors {
  fgAdd: string;
  fgDel: string;
  fgCtx: string;
}

let DEFAULT_DIFF_COLORS: DiffColors = { fgAdd: FG_ADD, fgDel: FG_DEL, fgCtx: FG_DIM };
let _lastResolvedThemeKey = "";

function themeCacheKey(theme?: PiTheme): string {
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

/** Resolve diff fg colors from theme (if available), falling back to hardcoded ANSI.
 *  On first call with a valid theme, auto-derives bg colors if no explicit config was set.
 *  Always reads toolSuccessBg for BG_BASE (used for context/add line backgrounds). */
function resolveDiffColors(theme?: PiTheme): DiffColors {
  const currentThemeKey = themeCacheKey(theme);
  if (!_hasExplicitBgConfig && _lastResolvedThemeKey && _lastResolvedThemeKey !== currentThemeKey) {
    BG_BASE = BG_DEFAULT;
    RST = "\x1b[0m";
    _autoDerivePending = true;
  }
  _lastResolvedThemeKey = currentThemeKey;
  // Always read toolSuccessBg for BG_BASE (even with explicit config)
  if (theme?.getBgAnsi && BG_BASE === BG_DEFAULT) {
    try {
      const bgAnsi = theme.getBgAnsi("toolSuccessBg");
      const parsed = parseAnsiRgb(bgAnsi);
      if (parsed) {
        BG_BASE = bgAnsi;
        RST = `\x1b[0m${BG_BASE}`;
      }
    } catch {
      /* ignore */
    }
  }

  // Auto-derive bg colors from theme on first render (if no explicit preset/overrides)
  if (_autoDerivePending && theme?.getFgAnsi) {
    autoDeriveBgFromTheme(theme);
    _autoDerivePending = false;
  }

  if (!theme?.getFgAnsi) return DEFAULT_DIFF_COLORS;
  try {
    const fgAdd = theme.getFgAnsi("toolDiffAdded") || FG_ADD;
    const fgDel = theme.getFgAnsi("toolDiffRemoved") || FG_DEL;
    const fgCtx = theme.getFgAnsi("toolDiffContext") || FG_DIM;
    return { fgAdd, fgDel, fgCtx };
  } catch {
    return DEFAULT_DIFF_COLORS;
  }
}

// ---------------------------------------------------------------------------
// Adaptive helpers
// ---------------------------------------------------------------------------

/** Returns max wrap rows based on current terminal width. Narrow = truncate, wide = allow wrapping. */
function adaptiveWrapRows(tw?: number): number {
  const w = tw ?? termW();
  if (w >= 180) return MAX_WRAP_ROWS_WIDE;
  if (w >= 120) return MAX_WRAP_ROWS_MED;
  return MAX_WRAP_ROWS_NARROW;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function strip(s: string): string {
  return s.replace(ANSI_RE, "");
}

function tabs(s: string): string {
  return s.replace(/\t/g, "  ");
}

function termW(): number {
  // Try multiple sources — process.stdout.columns may be undefined in piped/subagent contexts
  const raw =
    process.stdout.columns ||
    (process.stderr as any).columns ||
    Number.parseInt(process.env.COLUMNS ?? "", 10) ||
    DEFAULT_TERM_WIDTH;
  return Math.max(80, Math.min(raw - 4, MAX_TERM_WIDTH)); // -4 safety margin for pi TUI padding
}

/** Pad/truncate `s` to exactly `w` visible chars. ANSI-aware. */
function fit(s: string, w: number): string {
  if (w <= 0) return "";
  const plain = strip(s);
  if (plain.length <= w) return s + " ".repeat(w - plain.length);
  // Truncated — show content + dim › indicator
  const showW = w > 2 ? w - 1 : w;
  let vis = 0,
    i = 0;
  while (i < s.length && vis < showW) {
    if (s[i] === "\x1b") {
      const e = s.indexOf("m", i);
      if (e !== -1) {
        i = e + 1;
        continue;
      }
    }
    vis++;
    i++;
  }
  return w > 2 ? `${s.slice(0, i)}${RST}${FG_DIM}›${RST}` : `${s.slice(0, i)}${RST}`;
}

/** Extract last active fg + bg ANSI codes from a string. Used for wrapping continuations. */
function ansiState(s: string): string {
  let fg = "",
    bg = "";
  for (const match of s.matchAll(ANSI_CAPTURE_RE)) {
    const p = match[1] ?? "";
    const seq = match[0] ?? "";
    if (p === "0") {
      fg = "";
      bg = "";
    } else if (p === "39") {
      fg = "";
    } else if (p.startsWith("38;")) {
      fg = seq;
    } else if (p.startsWith("48;")) {
      bg = seq;
    }
  }
  return bg + fg;
}

function isLowContrastShikiFg(params: string): boolean {
  if (params === "30" || params === "90") return true;
  if (params === "38;5;0" || params === "38;5;8") return true;
  if (!params.startsWith("38;2;")) return false;
  const parts = params.split(";").map(Number);
  if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n))) return false;
  const [, , r, g, b] = parts;
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance < 72;
}

function normalizeShikiContrast(ansi: string): string {
  return ansi.replace(ANSI_PARAM_CAPTURE_RE, (seq, params: string) =>
    isLowContrastShikiFg(params) ? FG_SAFE_MUTED : seq,
  );
}

/** Wrap ANSI-encoded string into rows of `w` visible chars. Max `maxRows` rows; last row truncates with ›. */
function wrapAnsi(s: string, w: number, maxRows = adaptiveWrapRows(), fillBg = ""): string[] {
  if (w <= 0) return [""];
  const plain = strip(s);
  if (plain.length <= w) {
    const pad = w - plain.length;
    return pad > 0 ? [s + fillBg + " ".repeat(pad) + (fillBg ? RST : "")] : [s];
  }

  const rows: string[] = [];
  let row = "",
    vis = 0,
    i = 0;
  let onLastRow = false;
  let effW = w;

  while (i < s.length) {
    // When we reach the last allowed row, reserve 1 char for › indicator
    if (!onLastRow && rows.length >= maxRows - 1) {
      onLastRow = true;
      effW = w > 2 ? w - 1 : w;
    }

    // Pass through ANSI escapes
    if (s[i] === "\x1b") {
      const end = s.indexOf("m", i);
      if (end !== -1) {
        row += s.slice(i, end + 1);
        i = end + 1;
        continue;
      }
    }

    // Row full
    if (vis >= effW) {
      if (onLastRow) {
        // Check if remaining string has visible chars
        let hasMore = false;
        for (let j = i; j < s.length; j++) {
          if (s[j] === "\x1b") {
            const e2 = s.indexOf("m", j);
            if (e2 !== -1) {
              j = e2;
              continue;
            }
          }
          hasMore = true;
          break;
        }
        if (hasMore && w > 2) row += `${RST}${FG_DIM}›${RST}`;
        else row += fillBg + " ".repeat(Math.max(0, w - vis)) + RST;
        rows.push(row);
        return rows;
      }
      // Normal wrap — carry ANSI state forward
      const state = ansiState(row);
      rows.push(row + RST);
      row = state + fillBg;
      vis = 0;
      if (rows.length >= maxRows - 1) {
        onLastRow = true;
        effW = w > 2 ? w - 1 : w;
      }
    }

    row += s[i];
    vis++;
    i++;
  }

  // Final row, padded
  if (row.length > 0 || rows.length === 0) {
    rows.push(row + fillBg + " ".repeat(Math.max(0, w - vis)) + RST);
  }
  return rows;
}

function lnum(n: number | null, w: number, fg = FG_LNUM): string {
  if (n === null) return " ".repeat(w);
  const v = String(n);
  return `${fg}${" ".repeat(Math.max(0, w - v.length))}${v}${RST}`;
}

function shortPath(cwd: string, home: string, p: string): string {
  if (!p) return "";
  const r = relative(cwd, p);
  if (!r.startsWith("..") && !r.startsWith("/")) return r;
  return p.replace(home, "~");
}

function summarize(a: number, d: number): string {
  const p: string[] = [];
  if (a > 0) p.push(`${FG_ADD}+${a}${RST}`);
  if (d > 0) p.push(`${FG_DEL}-${d}${RST}`);
  return p.length ? p.join(" ") : `${FG_DIM}no changes${RST}`;
}

function rule(w: number): string {
  return `${BG_BASE}${FG_RULE}${"─".repeat(w)}${RST}`;
}

/**
 * Decide whether split view is readable for the given terminal width.
 * Prefers split view — side-by-side is always easier to scan.
 * Falls back to unified only when code columns would be too cramped
 * or too many lines would wrap even with adaptive truncation.
 */
function shouldUseSplit(diff: ParsedDiff, tw: number, maxRows = MAX_PREVIEW_LINES): boolean {
  if (!diff.lines.length) return false;
  if (tw < SPLIT_MIN_WIDTH) return false;

  const nw = Math.max(
    2,
    String(Math.max(...diff.lines.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length,
  );
  const half = Math.floor(tw / 2);
  const gw = nw + 4; // border + num + spaces around sign
  const cw = Math.max(12, half - gw);
  if (cw < SPLIT_MIN_CODE_WIDTH) return false;

  // Split view only helps balanced replacements. One-sided or heavily
  // imbalanced hunks waste a column and should use unified rendering.
  const vis = diff.lines.slice(0, maxRows);
  const visibleAdd = vis.filter((line) => line.type === "add").length;
  const visibleDel = vis.filter((line) => line.type === "del").length;
  if (visibleAdd === 0 || visibleDel === 0) return false;
  if (Math.max(visibleAdd, visibleDel) > Math.min(visibleAdd, visibleDel) * 2) return false;


  let contentLines = 0;
  let wrapCandidates = 0;
  for (const l of vis) {
    if (l.type === "sep") continue;
    contentLines++;
    if (tabs(l.content).length > cw) wrapCandidates++;
  }
  if (contentLines === 0) return true;

  const wrapRatio = wrapCandidates / contentLines;
  if (wrapCandidates >= SPLIT_MAX_WRAP_LINES) return false;
  if (wrapRatio >= SPLIT_MAX_WRAP_RATIO) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

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

function lang(fp: string): BundledLanguage | undefined {
  return EXT_LANG[extname(fp).slice(1).toLowerCase()];
}

// ---------------------------------------------------------------------------
// Shiki ANSI cache + pre-warm
// ---------------------------------------------------------------------------

// Pre-warm the Shiki singleton (loads WASM grammars + theme) so the first
// diff render doesn't pay the ~200-500ms startup cost.
codeToANSI("", "typescript", THEME).catch(() => {});

const _cache = new Map<string, string[]>();

function _touch(k: string, v: string[]): string[] {
  _cache.delete(k);
  _cache.set(k, v);
  while (_cache.size > CACHE_LIMIT) {
    const first = _cache.keys().next().value;
    if (first === undefined) break;
    _cache.delete(first);
  }
  return v;
}

async function hlBlock(code: string, language: BundledLanguage | undefined): Promise<string[]> {
  if (!code) return [""];
  if (!language || code.length > MAX_HL_CHARS) return code.split("\n");

  const k = `${THEME}\0${language}\0${code}`;
  const hit = _cache.get(k);
  if (hit) return _touch(k, hit);

  try {
    const ansi = normalizeShikiContrast(await codeToANSI(code, language, THEME));
    const out = (ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi).split("\n");
    return _touch(k, out);
  } catch {
    return code.split("\n");
  }
}

// ---------------------------------------------------------------------------
// Word diff + bg injection
//
// Key insight: Shiki's codeToANSI only emits fg codes (\x1b[38;...m and
// \x1b[39m). It never sets backgrounds.  So we can layer a diff bg underneath
// and it persists through all fg switches.  For word-level emphasis we swap
// the bg to a brighter shade at changed character positions.
// ---------------------------------------------------------------------------

/**
 * Combined word diff analysis — single Diff.diffWords() call returns both
 * similarity score and character ranges for emphasis highlighting.
 * Replaces separate wordDiffRanges + wordDiffSimilarity (which called diffWords twice).
 */
function wordDiffAnalysis(
  a: string,
  b: string,
): {
  similarity: number;
  oldRanges: Array<[number, number]>;
  newRanges: Array<[number, number]>;
} {
  if (!a && !b) return { similarity: 1, oldRanges: [], newRanges: [] };
  const parts = Diff.diffWords(a, b);
  const oldRanges: Array<[number, number]> = [];
  const newRanges: Array<[number, number]> = [];
  let oPos = 0,
    nPos = 0,
    same = 0;
  for (const p of parts) {
    if (p.removed) {
      oldRanges.push([oPos, oPos + p.value.length]);
      oPos += p.value.length;
    } else if (p.added) {
      newRanges.push([nPos, nPos + p.value.length]);
      nPos += p.value.length;
    } else {
      const len = p.value.length;
      same += len;
      oPos += len;
      nPos += len;
    }
  }
  const maxLen = Math.max(a.length, b.length);
  return { similarity: maxLen > 0 ? same / maxLen : 1, oldRanges, newRanges };
}

/**
 * Inject diff background into Shiki ANSI output.
 * `baseBg` on unchanged spans, `hlBg` on changed character ranges.
 * Re-injects bg after any full reset (\x1b[0m).
 *
 * Uses sorted-range pointer scan instead of Set (avoids O(totalChars) Set creation).
 */
function injectBg(
  ansiLine: string,
  ranges: Array<[number, number]>,
  baseBg: string,
  hlBg: string,
): string {
  let out = baseBg;
  let vis = 0;
  let inHL = false;
  let ri = 0; // current range index
  let i = 0;

  while (i < ansiLine.length) {
    if (ansiLine[i] === "\x1b") {
      const m = ansiLine.indexOf("m", i);
      if (m !== -1) {
        const seq = ansiLine.slice(i, m + 1);
        out += seq;
        // Re-inject bg after any reset-like sequence.
        // Shiki uses \x1b[39m (fg reset) between tokens — technically this
        // doesn't clear background per ANSI spec, but some terminal
        // emulators may treat it as a broader reset.
        if (seq === "\x1b[0m" || seq === "\x1b[39m" || seq === "\x1b[49m") {
          out += inHL ? hlBg : baseBg;
        }
        i = m + 1;
        continue;
      }
    }
    // Advance past exhausted ranges
    while (ri < ranges.length && vis >= ranges[ri][1]) ri++;
    const want = ri < ranges.length && vis >= ranges[ri][0] && vis < ranges[ri][1];
    if (want !== inHL) {
      inHL = want;
      out += inHL ? hlBg : baseBg;
    }
    out += ansiLine[i];
    vis++;
    i++;
  }
  return out + RST;
}

/** Simple word diff (no syntax hl) — fallback when Shiki isn't available. */
function plainWordDiff(oldText: string, newText: string): { old: string; new: string } {
  const parts = Diff.diffWords(oldText, newText);
  let o = "",
    n = "";
  for (const p of parts) {
    if (p.removed) o += `${BG_DEL_W}${p.value}${RST}${BG_DEL}`;
    else if (p.added) n += `${BG_ADD_W}${p.value}${RST}${BG_ADD}`;
    else {
      o += p.value;
      n += p.value;
    }
  }
  return { old: o, new: n };
}

// ---------------------------------------------------------------------------
// Stacked (unified) view — clean single-column layout
//
// Modelled after Shiki diff/GitHub stacked view:
//   • Single line-number column (shows old num for del/ctx, new num for add)
//   • Compact gutter: "NNN-│" or "NNN+│" or "NNN │"
//   • Full-width code — no side-by-side cramming
//   • Hunk separators as "··· N unmodified lines ···"
//   • Paired del/add lines adjacent with word-level emphasis
// ---------------------------------------------------------------------------

async function renderUnified(
  diff: ParsedDiff,
  language: BundledLanguage | undefined,
  max = MAX_RENDER_LINES,
  dc: DiffColors = DEFAULT_DIFF_COLORS,
): Promise<string> {
  if (!diff.lines.length) return "";

  const vis = diff.lines.slice(0, max);
  const tw = termW();
  const nw = Math.max(2, String(Math.max(...vis.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length);
  const gw = nw + 4; // border + num + spaces around sign
  const cw = Math.max(20, tw - gw);
  const canHL = diff.chars <= MAX_HL_CHARS && vis.length <= MAX_RENDER_LINES;

  // Build separate old/new code blocks for highlighting
  const oldSrc: string[] = [],
    newSrc: string[] = [];
  for (const l of vis) {
    if (l.type === "ctx" || l.type === "del") oldSrc.push(l.content);
    if (l.type === "ctx" || l.type === "add") newSrc.push(l.content);
  }
  const [oldHL, newHL] = canHL
    ? await Promise.all([
        hlBlock(oldSrc.join("\n"), language),
        hlBlock(newSrc.join("\n"), language),
      ])
    : [oldSrc, newSrc];

  let oI = 0,
    nI = 0,
    idx = 0;
  const out: string[] = [];

  /** Emit a single stacked row with compact gutter + left border bar. */
  function emitRow(
    num: number | null,
    sign: string,
    gutterBg: string,
    signFg: string,
    body: string,
    bodyBg = "",
  ): void {
    const borderFg = sign === "-" ? dc.fgDel : sign === "+" ? dc.fgAdd : "";
    const border = borderFg ? `${borderFg}${getBorderBar()}${RST}` : `${BG_BASE} `;
    const numFg = borderFg || FG_LNUM;
    const gutter = `${border}${gutterBg}${lnum(num, nw, numFg)}${gutterBg} ${signFg}${sign}${gutterBg} ${RST}`;
    const contGutter = `${border}${gutterBg}${" ".repeat(nw + 3)}${RST}`;
    const rows = wrapAnsi(tabs(body), cw, adaptiveWrapRows(), bodyBg);
    out.push(`${gutter}${rows[0]}${RST}`);
    for (let r = 1; r < rows.length; r++) out.push(`${contGutter}${rows[r]}${RST}`);
  }

  while (idx < vis.length) {
    const l = vis[idx];

    // Hunk separator — collapsed context with optional function context
    if (l.type === "sep") {
      const label = sepLabelUnified(getSepStyle(), l.hunkMeta, l.newNum, l.content);
      if (!label) {
        idx++;
        continue;
      }
      const totalW = Math.min(tw, 72);
      const pad = Math.max(0, totalW - label.length - 2);
      const half1 = Math.floor(pad / 2),
        half2 = pad - half1;
      out.push(`${BG_BASE}${FG_DIM}${"─".repeat(half1)}${label}${"─".repeat(half2)}${RST}`);
      idx++;
      continue;
    }

    // Context line — dimmed, single line number
    if (l.type === "ctx") {
      const hl = oldHL[oI] ?? l.content;
      emitRow(l.newNum, " ", BG_BASE, dc.fgCtx, `${BG_BASE}${DIM}${hl}`, BG_BASE);
      oI++;
      nI++;
      idx++;
      continue;
    }

    // Collect del/add blocks
    const dels: Array<{ l: DiffLine; hl: string }> = [];
    while (idx < vis.length && vis[idx].type === "del") {
      dels.push({ l: vis[idx], hl: oldHL[oI] ?? vis[idx].content });
      oI++;
      idx++;
    }
    const adds: Array<{ l: DiffLine; hl: string }> = [];
    while (idx < vis.length && vis[idx].type === "add") {
      adds.push({ l: vis[idx], hl: newHL[nI] ?? vis[idx].content });
      nI++;
      idx++;
    }

    // 1:1 paired → word diff emphasis
    const isPaired = dels.length === 1 && adds.length === 1;
    const wd = isPaired ? wordDiffAnalysis(dels[0].l.content, adds[0].l.content) : null;

    // Word-diff emphasis — only use when BOTH sides have ranges.
    // When diffWords treats trailing punctuation as "common" while removing
    // adjacent chars, only one side gets word highlights, creating a confusing
    // visual ("off by 1" perception). Skip word-level in that case.
    const wdBalanced = wd && wd.oldRanges.length > 0 && wd.newRanges.length > 0;

    if (isPaired && wdBalanced && wd.similarity >= WORD_DIFF_MIN_SIM && canHL) {
      const delBody = injectBg(dels[0].hl, wd.oldRanges, BG_DEL, BG_DEL_W);
      const addBody = injectBg(adds[0].hl, wd.newRanges, BG_ADD, BG_ADD_W);
      emitRow(dels[0].l.oldNum, "-", BG_GUTTER_DEL, dc.fgDel, delBody, BG_DEL);
      emitRow(adds[0].l.newNum, "+", BG_GUTTER_ADD, dc.fgAdd, addBody, BG_ADD);
      continue;
    }
    if (isPaired && wdBalanced && wd.similarity >= WORD_DIFF_MIN_SIM && !canHL) {
      const pwd = plainWordDiff(dels[0].l.content, adds[0].l.content);
      emitRow(dels[0].l.oldNum, "-", BG_GUTTER_DEL, dc.fgDel, `${BG_DEL}${pwd.old}`, BG_DEL);
      emitRow(adds[0].l.newNum, "+", BG_GUTTER_ADD, dc.fgAdd, `${BG_ADD}${pwd.new}`, BG_ADD);
      continue;
    }

    // Multi-line blocks — syntax highlighted with diff bg
    for (const d of dels) {
      const body = canHL ? injectBg(d.hl, [], BG_DEL, BG_DEL) : `${BG_DEL}${d.l.content}`;
      emitRow(d.l.oldNum, "-", BG_GUTTER_DEL, dc.fgDel, body, BG_DEL);
    }
    for (const a of adds) {
      const body = canHL ? injectBg(a.hl, [], BG_ADD, BG_ADD) : `${BG_ADD}${a.l.content}`;
      emitRow(a.l.newNum, "+", BG_GUTTER_ADD, dc.fgAdd, body, BG_ADD);
    }
  }

  if (diff.lines.length > vis.length) {
    out.push(`${BG_BASE}${FG_DIM}  … ${diff.lines.length - vis.length} more lines${RST}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Split view (auto-fallback to unified when narrow)
// ---------------------------------------------------------------------------

async function renderSplit(
  diff: ParsedDiff,
  language: BundledLanguage | undefined,
  max = MAX_PREVIEW_LINES,
  dc: DiffColors = DEFAULT_DIFF_COLORS,
): Promise<string> {
  const tw = termW();
  if (!shouldUseSplit(diff, tw, max)) return renderUnified(diff, language, max, dc);
  if (!diff.lines.length) return "";

  // Build rows — process ctx/sep individually, group del/add blocks
  type Row = { left: DiffLine | null; right: DiffLine | null };
  const rows: Row[] = [];
  let i = 0;
  while (i < diff.lines.length) {
    const l = diff.lines[i];
    if (l.type === "ctx") {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    if (l.type === "sep") {
      rows.push({ left: l, right: l });
      i++;
      continue;
    }
    // Collect del/add block
    const dels: DiffLine[] = [];
    while (i < diff.lines.length && diff.lines[i].type === "del") {
      dels.push(diff.lines[i]);
      i++;
    }
    const adds: DiffLine[] = [];
    while (i < diff.lines.length && diff.lines[i].type === "add") {
      adds.push(diff.lines[i]);
      i++;
    }
    const n = Math.max(dels.length, adds.length);
    for (let j = 0; j < n; j++) rows.push({ left: dels[j] ?? null, right: adds[j] ?? null });
  }
  const vis = rows.slice(0, max);
  const nw = Math.max(
    2,
    String(Math.max(...diff.lines.map((l) => l.oldNum ?? l.newNum ?? 0), 0)).length,
  );
  const gw = nw + 4; // border + num + spaces around sign
  const half = Math.floor(tw / 2);
  const cw = Math.max(12, half - gw);
  const canHL = diff.chars <= MAX_HL_CHARS && vis.length * 2 <= MAX_RENDER_LINES * 2;

  // Build separate code blocks per side
  const leftSrc: string[] = [],
    rightSrc: string[] = [];
  for (const r of vis) {
    if (r.left && r.left.type !== "sep") leftSrc.push(r.left.content);
    if (r.right && r.right.type !== "sep") rightSrc.push(r.right.content);
  }
  const [leftHL, rightHL] = canHL
    ? await Promise.all([
        hlBlock(leftSrc.join("\n"), language),
        hlBlock(rightSrc.join("\n"), language),
      ])
    : [leftSrc, rightSrc];

  let lI = 0,
    rI = 0;
  let stripeRow = 0; // tracks row index for diagonal stripe offset

  // Returns { gutter, contGutter, body } for wrapping composition
  type HalfResult = { gutter: string; contGutter: string; bodyRows: string[] };

  function half_build(
    line: DiffLine | null,
    hl: string,
    ranges: Array<[number, number]> | null,
    side: "left" | "right",
  ): HalfResult {
    // Empty filler — render nothing to avoid dead-column gaps.
    if (!line) {
      return { gutter: "", contGutter: "", bodyRows: [""] };
    }
    // Hunk separator with optional function context
    if (line.type === "sep") {
      const label = sepLabelSplit(getSepStyle(), line.hunkMeta, line.newNum, line.content);
      if (!label) return { gutter: "", contGutter: "", bodyRows: [""] };
      const g = `${BG_BASE} ${FG_DIM}${fit("", nw + 3)}${RST}`;
      return { gutter: g, contGutter: g, bodyRows: [`${BG_BASE}${FG_DIM}${fit(label, cw)}${RST}`] };
    }

    const isDel = line.type === "del",
      isAdd = line.type === "add";
    const gBg = isDel ? BG_GUTTER_DEL : isAdd ? BG_GUTTER_ADD : BG_BASE;
    const cBg = isDel ? BG_DEL : isAdd ? BG_ADD : BG_BASE;
    const sFg = isDel ? dc.fgDel : isAdd ? dc.fgAdd : dc.fgCtx;
    const sign = isDel ? "-" : isAdd ? "+" : " ";
    const num = isDel
      ? line.oldNum
      : isAdd
        ? line.newNum
        : side === "left"
          ? line.oldNum
          : line.newNum;

    // Border bar + colored line numbers for changed lines
    const borderFg = isDel ? dc.fgDel : isAdd ? dc.fgAdd : "";
    const border = borderFg ? `${borderFg}${getBorderBar()}${RST}` : ` ${BG_BASE}`;
    const numFg = borderFg || FG_LNUM;

    let body: string;
    if (ranges && ranges.length > 0) {
      body = injectBg(hl, ranges, cBg, isDel ? BG_DEL_W : BG_ADD_W);
    } else if (isDel || isAdd) {
      body = injectBg(hl, [], cBg, cBg);
    } else {
      body = `${BG_BASE}${DIM}${hl}`;
    }

    const gutter = `${border}${gBg}${lnum(num, nw, numFg)}${gBg} ${sFg}${sign}${gBg} ${RST}`;
    const contGutter = `${border}${gBg}${" ".repeat(nw + 3)}${RST}`;
    const bodyRows = wrapAnsi(tabs(body), cw, adaptiveWrapRows(), cBg);
    return { gutter, contGutter, bodyRows };
  }

  const out: string[] = [];
  // Column headers — "old" / "new" positioned above line numbers
  const hdrOld = `${BG_BASE}${" ".repeat(Math.max(0, nw - 2))}${dc.fgDel}${DIM}old${RST}`;
  const hdrNew = `${BG_BASE}${" ".repeat(Math.max(0, nw - 2))}${dc.fgAdd}${DIM}new${RST}`;
  out.push(
    `${BG_BASE}${hdrOld}${" ".repeat(Math.max(0, half - nw))}${hdrNew}`,
  );

  for (const r of vis) {
    const leftLine = r.left,
      rightLine = r.right;
    const paired = leftLine && rightLine && leftLine.type === "del" && rightLine.type === "add";
    const wd = paired ? wordDiffAnalysis(leftLine.content, rightLine.content) : null;

    let lResult: HalfResult, rResult: HalfResult;

    if (paired && wd && wd.similarity >= WORD_DIFF_MIN_SIM && canHL) {
      const lhl = leftHL[lI++] ?? leftLine.content;
      const rhl = rightHL[rI++] ?? rightLine.content;
      lResult = half_build(leftLine, lhl, wd.oldRanges, "left");
      rResult = half_build(rightLine, rhl, wd.newRanges, "right");
    } else if (paired && wd && wd.similarity >= WORD_DIFF_MIN_SIM && !canHL) {
      const pwd = plainWordDiff(leftLine.content, rightLine.content);
      lI++;
      rI++;
      lResult = half_build(leftLine, pwd.old, null, "left");
      rResult = half_build(rightLine, pwd.new, null, "right");
    } else {
      const lhl =
        leftLine && leftLine.type !== "sep" ? (leftHL[lI++] ?? leftLine?.content ?? "") : "";
      const rhl =
        rightLine && rightLine.type !== "sep" ? (rightHL[rI++] ?? rightLine?.content ?? "") : "";
      lResult = half_build(leftLine, lhl, null, "left");
      rResult = half_build(rightLine, rhl, null, "right");
    }

    // Compose wrapped rows; missing sides render empty to avoid dead-column gaps.
    const maxRows = Math.max(lResult.bodyRows.length, rResult.bodyRows.length);
    for (let row = 0; row < maxRows; row++) {
      const lg = row === 0 ? lResult.gutter : lResult.contGutter;
      const rg = row === 0 ? rResult.gutter : rResult.contGutter;
      const lb = lResult.bodyRows[row] ?? "";
      const rb = rResult.bodyRows[row] ?? "";
      if (!lg && !rg && !lb && !rb) continue;
      out.push(`${lg}${lb.trimEnd()}${rg}${rb.trimEnd()}`);
      stripeRow++;
    }
  }

  if (rows.length > vis.length) {
    out.push(`${BG_BASE}${FG_DIM}  … ${rows.length - vis.length} more lines${RST}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export const __testing = {
  computeHunkBlocks,
  normalizeShikiContrast,
  getSepStyle,
  parseDiff,
  parsePatchFiles,
  resolveSepStyle,
  renderSplit,
  renderUnified,
};

export default async function diffRendererExtension(pi: ExtensionAPI): Promise<void> {
  // Apply diff theme palette from settings/presets before rendering
  applySharedDiffPalette();
  // Resolve hunk separator style from env var
  resolveSepStyle();

  let createWriteTool: any,
    createEditTool: any,
    getMarkdownTheme: any,
    TextComponent: any,
    MarkdownComponent: any;
  try {
    const sdk = await import("@earendil-works/pi-coding-agent");
    const tui = await import("@earendil-works/pi-tui");
    createWriteTool = sdk.createWriteTool;
    createEditTool = sdk.createEditTool;
    getMarkdownTheme = sdk.getMarkdownTheme;
    TextComponent = tui.Text;
    MarkdownComponent = tui.Markdown;
  } catch (error) {
    console.error(
      `[pi-diff] failed to load Pi SDK dependencies: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  if (!createWriteTool || !createEditTool || !TextComponent) return;

  const cwd = process.cwd();
  const home = process.env.HOME ?? "";
  const sp = (p: string) => shortPath(cwd, home, p);
  const TOOL_HEADER_LEFT_PAD = 2;
  const TOOL_HEADER_TOP_PAD = 1;
  const TOOL_PREVIEW_BOTTOM_PAD = 1;
  const DIFF_BODY_LEFT_PAD = 1;

  function resolvePreviewDiffColors(theme: any): DiffColors {
    resolveDiffColors(theme);
    return resolveSharedDiffColors(theme);
  }

  function bgLine(content: string, width: number): string {
    const renderWidth = Math.max(1, width);
    const padding = " ".repeat(Math.max(0, renderWidth - strip(content).length));
    return injectBg(`${content}${padding}`, [], BG_BASE, BG_BASE);
  }

  function formatToolHeader(summary: string, width: number): string {
    const leftPad = " ".repeat(TOOL_HEADER_LEFT_PAD);
    const meta = `${leftPad}${summary}`;
    return bgLine(meta, width);
  }

  function formatToolTitle(
    label: string,
    filePath: string,
    theme: any,
    width: number,
    suffix = "",
  ): string {
    const leftPad = " ".repeat(TOOL_HEADER_LEFT_PAD);
    const displayPath = filePath ? ` ${theme.fg("accent", sp(filePath))}` : "";
    const top = Array.from({ length: TOOL_HEADER_TOP_PAD }, () => bgLine("", width));
    return [
      ...top,
      bgLine(`${leftPad}${theme.fg("toolTitle", theme.bold(label))}${displayPath}${suffix}`, width),
    ].join("\n");
  }

  function formatBottomPadding(width: number): string {
    return Array.from({ length: TOOL_PREVIEW_BOTTOM_PAD }, () => bgLine("", width)).join("\n");
  }

  function padDiffBody(rendered: string): string {
    const leftPad = `${BG_BASE}${" ".repeat(DIFF_BODY_LEFT_PAD)}${RST}`;
    return rendered
      .split("\n")
      .map((line) => `${leftPad}${line}`)
      .join("\n");
  }

  async function renderPaddedDiff(
    diff: ParsedDiff,
    language: BundledLanguage | undefined,
    maxLines: number,
    colors: DiffColors,
    width: number,
  ): Promise<string> {
    const bodyWidth = Math.max(1, width - DIFF_BODY_LEFT_PAD);
    return padDiffBody(await renderSharedSplit(diff, language, maxLines, colors, bodyWidth));
  }

  function diffLineCountLabel(diffLineCount: unknown, theme: any): string {
    if (typeof diffLineCount !== "number") return "";
    return ` ${theme.fg("muted", `(${diffLineCount} diff lines)`)}`;
  }

  function setToolHeaderText(
    text: { __piDiffTask?: unknown; setText(text: string): void },
    meta: string,
    theme: any,
  ): void {
    resolvePreviewDiffColors(theme);
    text.__piDiffTask = undefined;
    const width = termW();
    text.setText(`${formatToolHeader(meta, width)}\n${formatBottomPadding(width)}`);
  }

  function setDiffPreviewTask(
    text: { __piDiffTask?: unknown },
    keyPrefix: string,
    meta: string,
    diff: ParsedDiff,
    language: BundledLanguage | undefined,
    maxLines: number,
    theme: any,
    ctx: any,
  ): void {
    const themeKey = sharedThemeCacheKey(theme);
    const colors = resolvePreviewDiffColors(theme);
    const header = (width: number) => formatToolHeader(meta, width);
    text.__piDiffTask = {
      placeholder: `${header(termW())}\n${padDiffBody(theme.fg("muted", "rendering diff…"))}\n${formatBottomPadding(termW())}`,
      fallback: `${header(termW())}\n${formatBottomPadding(termW())}`,
      invalidate: ctx.invalidate,
      key: (width: number) =>
        `${keyPrefix}:${themeKey}:${width}:${meta}:${diff.lines.length}:${language ?? ""}`,
      render: async (width: number) =>
        `${header(width)}\n${await renderPaddedDiff(diff, language, maxLines, colors, width)}\n${formatBottomPadding(width)}`,
    };
  }

  // ── Sidebar-aware async rendering ──
  /** Extended Text component with pi-diff's rendering state. */
  interface MonitoredText extends Component {
    setText(text: string): void;
    __piDiffWidthAware?: boolean;
    __piDiffRender?: (width: number) => string[];
    __piDiffRenderedKey?: string;
    __piDiffTask?: {
      placeholder: string;
      fallback: string;
      invalidate: () => void;
      key: (width: number) => string;
      render: (width: number) => Promise<string>;
    };
  }
  /** Wrap a Text component so its render(width) kicks off async diff rendering
   *  using the real TUI width (which accounts for the sidebar). */
  function getWidthAwareText(lastComponent: Component | undefined): MonitoredText {
    const text = (lastComponent ?? new TextComponent("", 0, 0)) as MonitoredText;
    if (text.__piDiffWidthAware) return text;
    const baseRender = typeof text.render === "function" ? text.render.bind(text) : null;
    if (!baseRender) return text;
    text.__piDiffWidthAware = true;
    text.__piDiffRender = baseRender as (width: number) => string[];
    text.render = (width: number) => {
      const task = text.__piDiffTask;
      if (task) {
        const renderWidth = Math.max(1, Math.floor(width || termW()));
        const key = task.key(renderWidth);
        if (text.__piDiffRenderedKey !== key) {
          text.__piDiffRenderedKey = key;
          text.setText(task.placeholder);
          Promise.resolve(task.render(renderWidth))
            .then((rendered: string) => {
              if (text.__piDiffRenderedKey !== key) return;
              text.setText(rendered);
              task.invalidate?.();
            })
            .catch(() => {
              if (text.__piDiffRenderedKey !== key) return;
              text.setText(task.fallback);
              task.invalidate?.();
            });
        }
      }
      return text.__piDiffRender?.(width) ?? [];
    };
    return text;
  }

      // =======================================================================
      // write
      // =======================================================================

  const origWrite = createWriteTool(cwd);

  pi.registerTool({
    ...origWrite,
    name: "write",

    async execute(tid: string, params: any, sig: any, upd: any, ctx: any) {
      const fp = params.path ?? params.file_path ?? "";
      let old: string | null = null;
      try {
        if (fp && existsSync(fp)) old = readFileSync(fp, "utf-8");
      } catch {
        old = null;
      }

      const result = await origWrite.execute(tid, params, sig, upd, ctx);
      const content = params.content ?? "";

      // Store in details — the only custom field TUI preserves in renderResult
      if (old !== null && old !== content) {
        const useFull = !!(params as any)._expandGaps;
        const diff = parseDiff(old, content, useFull ? undefined : 3);
        const lg = detectDiffLanguage(fp);
        (result as Record<string, unknown>).details = {
          _type: "diff",
          summary: summarize(diff.added, diff.removed),
          filePath: fp,
          diff,
          language: lg,
          oldContent: old,
          newContent: content,
        };
      } else if (old === null) {
        const lineCount = content ? content.split("\n").length : 0;
        (result as Record<string, unknown>).details = {
          _type: "new",
          lines: lineCount,
          content: content ?? "",
          filePath: fp,
        };
      } else if (old === content) {
        (result as Record<string, unknown>).details = { _type: "noChange" };
      }
      return result;
    },

    renderCall(args: any, theme: any, ctx: any) {
      const fp = args?.path ?? args?.file_path ?? "";
      const isNew = !fp || !existsSync(fp);
      const label = isNew ? "create" : "write";
      const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
      const hdr = `${theme.fg("toolTitle", theme.bold(label))} ${theme.fg("accent", sp(fp))}`;

      // Streaming
      if (args?.content && !ctx.argsComplete) {
        const n = String(args.content).split("\n").length;
        text.setText(`${hdr}  ${theme.fg("muted", `(${n} lines…)`)}`);
        return text;
      }

      // New file preview with Shiki
      if (args?.content && ctx.argsComplete && isNew) {
        const previewKey = `create:${sharedThemeCacheKey(theme)}:${fp}:${String(args.content).length}`;
        if (ctx.state._previewKey !== previewKey) {
          ctx.state._previewKey = previewKey;
          ctx.state._previewText = hdr;
          const lg = detectDiffLanguage(fp);
          hlBlock(args.content, lg)
            .then((lines: string[]) => {
              if (ctx.state._previewKey !== previewKey) return;
              const maxShow = ctx.expanded ? lines.length : 16;
              const preview = lines.slice(0, maxShow).join("\n");
              const rem = lines.length - maxShow;
              let out = `${hdr}\n\n${preview}`;
              if (rem > 0)
                out += `\n${theme.fg("muted", `… (${rem} more lines, ${lines.length} total)`)}`;
              ctx.state._previewText = out;
              ctx.invalidate();
            })
            .catch(() => {});
        }
        text.setText(ctx.state._previewText ?? hdr);
        return text;
      }

      text.setText(hdr);
      return text;
    },

    renderResult(result: any, _opt: any, theme: any, ctx: any) {
      const text = getWidthAwareText(ctx.lastComponent);
      if (ctx.isError) {
        const e =
          result.content
            ?.filter((c: { type: string; text?: string }) => c.type === "text")
            .map((c: { type: string; text?: string }) => c.text || "")
            .join("\n") ?? "Error";
        text.__piDiffTask = undefined;
        text.setText(`\n${theme.fg("error", e)}`);
        return text;
      }
      const d = result.details;
      if (d?._type === "diff") {
        setDiffPreviewTask(text, "wd", d.summary, d.diff, d.language, MAX_RENDER_LINES, theme, ctx);
        return text;
      }
      if (d?._type === "noChange") {
        text.__piDiffTask = undefined;
        text.setText(`  ${theme.fg("muted", "✓ no changes")}`);
        return text;
      }
      if (d?._type === "new") {
        const { lines: lineCount, content: rawContent, filePath: fp } = d;
        const pk = `nf:${sharedThemeCacheKey(theme)}:${fp}:${lineCount}`;
        if (ctx.state._nfk !== pk) {
          ctx.state._nfk = pk;
          ctx.state._nft = `  ${theme.fg("success", `✓ new file (${lineCount} lines)`)}`;
          const lg = detectDiffLanguage(fp);
          if (rawContent) {
            hlBlock(rawContent, lg)
              .then((hlLines: string[]) => {
                if (ctx.state._nfk !== pk) return;
                const maxShow = ctx.expanded ? hlLines.length : 12;
                const preview = hlLines.slice(0, maxShow).join("\n");
                const rem = hlLines.length - maxShow;
                let out = `  ${theme.fg("success", `✓ new file (${lineCount} lines)`)}\n${preview}`;
                if (rem > 0) out += `\n${theme.fg("muted", `  … ${rem} more lines`)}`;
                ctx.state._nft = out;
                ctx.invalidate();
              })
              .catch(() => {});
          }
        }
        text.setText(
          ctx.state._nft ?? `  ${theme.fg("success", `✓ new file (${lineCount} lines)`)}`,
        );
        return text;
      }
      text.setText(
        `  ${theme.fg("dim", String(result?.content?.[0]?.text ?? "written").slice(0, 120))}`,
      );
      return text;
    },
  });

  // =======================================================================
  // edit
  // =======================================================================

  const origEdit = createEditTool(cwd);

  function getEditOperations(input: any): Array<{ oldText: string; newText: string }> {
    if (Array.isArray(input?.edits)) {
      return input.edits
        .map((edit: any) => ({
          oldText:
            typeof edit?.oldText === "string"
              ? edit.oldText
              : typeof edit?.old_text === "string"
                ? edit.old_text
                : "",
          newText:
            typeof edit?.newText === "string"
              ? edit.newText
              : typeof edit?.new_text === "string"
                ? edit.new_text
                : "",
        }))
        .filter(
          (edit: { oldText: string; newText: string }) =>
            edit.oldText && edit.oldText !== edit.newText,
        );
    }

    const oldText =
      typeof input?.oldText === "string"
        ? input.oldText
        : typeof input?.old_text === "string"
          ? input.old_text
          : "";
    const newText =
      typeof input?.newText === "string"
        ? input.newText
        : typeof input?.new_text === "string"
          ? input.new_text
          : "";
    return oldText && oldText !== newText ? [{ oldText, newText }] : [];
  }

  function summarizeEditOperations(operations: Array<{ oldText: string; newText: string }>) {
    const diffs = operations.map((edit) => parseDiff(edit.oldText, edit.newText));
    const totalAdded = diffs.reduce((sum, diff) => sum + diff.added, 0);
    const totalRemoved = diffs.reduce((sum, diff) => sum + diff.removed, 0);
    return {
      diffs,
      totalAdded,
      totalRemoved,
      summary: summarize(totalAdded, totalRemoved),
    };
  }

  pi.registerTool({
    ...origEdit,
    name: "edit",

    async execute(tid: string, params: any, sig: any, upd: any, ctx: any) {
      const fp = params.path ?? params.file_path ?? "";
      const operations = getEditOperations(params);

      // Try cascading replace() first — smarter matching than SDK's exact-only edit
      if (fp && operations.length > 0 && existsSync(fp)) {
        try {
          let content = readFileSync(fp, "utf-8");
          let firstStrategy = "";
          let replaceOk = true;

          for (const op of operations) {
            const r = replace(content, op.oldText, op.newText);
            if (r.changed) {
              content = r.content;
              if (!firstStrategy) firstStrategy = r.strategy;
            } else {
              replaceOk = false;
              break;
            }
          }

          if (replaceOk) {
            writeFileSync(fp, content, "utf-8");

            const { diffs, summary } = summarizeEditOperations(operations);
            const lg = detectDiffLanguage(fp);

            if (operations.length === 1) {
              let editLine = 0;
              try {
                const idx = content.indexOf(operations[0].newText);
                if (idx >= 0) editLine = content.slice(0, idx).split("\n").length;
              } catch {
                editLine = 0;
              }
              const useFull = !!(params as any)._expandGaps;
              const diffData = useFull
                ? parseDiff(operations[0].oldText, operations[0].newText, undefined)
                : diffs[0];
              return {
                content: [{ type: "text" as const, text: `Edited ${sp(fp)}` }],
                details: {
                  _type: "editInfo",
                  summary,
                  filePath: fp,
                  editLine,
                  diff: diffData,
                  language: lg,
                  oldContent: operations[0].oldText,
                  newContent: operations[0].newText,
                  _replaceStrategy: firstStrategy,
                },
              };
            }

            // Merge all diffs into one combined view for rendering
            const merged: (typeof diffs)[0] = {
              lines: diffs.flatMap((diff, i) => [
                ...(i > 0
                  ? [
                      {
                        type: "sep" as const,
                        oldNum: null,
                        newNum: null,
                        content: `───── Edit ${i + 1} ─────`,
                      },
                    ]
                  : []),
                ...diff.lines,
              ]),
              added: diffs.reduce((sum, diff) => sum + diff.added, 0),
              removed: diffs.reduce((sum, diff) => sum + diff.removed, 0),
              chars: diffs.reduce((sum, diff) => sum + diff.chars, 0),
            };
            return {
              content: [{ type: "text" as const, text: `Edited ${sp(fp)}` }],
              details: {
                _type: "multiEditInfo",
                summary,
                filePath: fp,
                editCount: operations.length,
                diffLineCount: merged.lines.length,
                diff: merged,
                language: lg,
              },
            };
          }
        } catch (replaceError) {
          // replace() failed; fall through to SDK edit tool
          console.warn(
            `[pi-diff] replace() failed, falling back to SDK: ${replaceError instanceof Error ? replaceError.message : String(replaceError)}`,
          );
        }
      }

      const result = await origEdit.execute(tid, params, sig, upd, ctx);

      if (operations.length === 0) return result;

      const { diffs, summary } = summarizeEditOperations(operations);
      const lg = detectDiffLanguage(fp);
      if (operations.length === 1) {
        let editLine = 0;
        try {
          if (fp && existsSync(fp)) {
            const f = readFileSync(fp, "utf-8");
            const idx = f.indexOf(operations[0].newText);
            if (idx >= 0) editLine = f.slice(0, idx).split("\n").length;
          }
        } catch {
          editLine = 0;
        }
        const useFull = !!(params as any)._expandGaps;
        const diffData = useFull
          ? parseDiff(operations[0].oldText, operations[0].newText, undefined)
          : diffs[0];
        (result as Record<string, unknown>).details = {
          _type: "editInfo",
          summary,
          filePath: fp,
          editLine,
          diff: diffData,
          language: lg,
          oldContent: operations[0].oldText,
          newContent: operations[0].newText,
        };
        return result;
      }

      // Merge all diffs into one combined view for rendering
      const merged: (typeof diffs)[0] = {
        lines: diffs.flatMap((diff, i) => [
          // Add separator between multiple edits
          ...(i > 0
            ? [
                {
                  type: "sep" as const,
                  oldNum: null,
                  newNum: null,
                  content: `───── Edit ${i + 1} ─────`,
                },
              ]
            : []),
          ...diff.lines,
        ]),
        added: diffs.reduce((sum, diff) => sum + diff.added, 0),
        removed: diffs.reduce((sum, diff) => sum + diff.removed, 0),
        chars: diffs.reduce((sum, diff) => sum + diff.chars, 0),
      };
      (result as Record<string, unknown>).details = {
        _type: "multiEditInfo",
        summary,
        filePath: fp,
        editCount: operations.length,
        diffLineCount: merged.lines.length,
        diff: merged,
        language: lg,
      };
      return result;
    },

    renderCall(args: any, theme: any, ctx: any) {
      const fp = args?.path ?? args?.file_path ?? "";
      const operations = getEditOperations(args);
      const text = ctx.lastComponent ?? new TextComponent("", 0, 0);
      resolvePreviewDiffColors(theme);

      if (ctx.argsComplete && operations.length > 0) {
        const { totalAdded, totalRemoved } = summarizeEditOperations(operations);
        text.setText(
          formatToolTitle(
            "edit",
            fp,
            theme,
            termW(),
            `  ${theme.fg("muted", summarize(totalAdded, totalRemoved))}`,
          ),
        );
      } else {
        text.setText(formatToolTitle("edit", fp, theme, termW()));
      }
      return text;
    },

    renderResult(result: any, _opt: any, theme: any, ctx: any) {
      const text = getWidthAwareText(ctx.lastComponent);
      if (ctx.isError) {
        const e =
          result.content
            ?.filter((c: { type: string; text?: string }) => c.type === "text")
            .map((c: { type: string; text?: string }) => c.text || "")
            .join("\n") ?? "Error";
        text.__piDiffTask = undefined;
        text.setText(`\n${theme.fg("error", e)}`);
        return text;
      }
      const d = result.details;
      if (d?._type === "editInfo" && d.diff) {
        const loc = d.editLine > 0 ? ` ${theme.fg("muted", `at line ${d.editLine}`)}` : "";
        setDiffPreviewTask(
          text,
          "ed",
          `${d.summary}${loc}`,
          d.diff,
          d.language,
          MAX_PREVIEW_LINES,
          theme,
          ctx,
        );
        return text;
      }
      if (d?._type === "editInfo") {
        const { summary: s, editLine } = d;
        const loc = editLine > 0 ? ` ${theme.fg("muted", `at line ${editLine}`)}` : "";
        setToolHeaderText(text, `${s}${loc}`, theme);
        return text;
      }
      if (d?._type === "multiEditInfo") {
        const { summary: s, editCount, diffLineCount, diff, language } = d;
        const meta = `${editCount} edits ${s}${diffLineCountLabel(diffLineCount, theme)}`;
        if (diff) {
          setDiffPreviewTask(text, "me", meta, diff, language, MAX_PREVIEW_LINES, theme, ctx);
          return text;
        }
        setToolHeaderText(text, meta, theme);
        return text;
      }
      text.__piDiffTask = undefined;
      text.setText(
        `  ${theme.fg("dim", String(result?.content?.[0]?.text ?? "edited").slice(0, 120))}`,
      );
      return text;
    },
  });
}
