// ---------------------------------------------------------------------------
// pi-diff.json config loader
//
// Config priority (highest first):
//   1. Environment variables (PI_DIFF_*) — for runtime/tool overrides
//   2. Project-level pi-diff.json (<cwd>/pi-diff.json)
//   3. Project-level .pi/pi-diff.json (pi-standard hidden config dir)
//   4. Global-level pi-diff.json (~/.pi/agent/pi-diff.json)
//   5. Global-level pi-diff.json (~/.pi/pi-diff.json)
//   6. Hardcoded defaults
//
// The env vars are read by the individual resolvers in diff.ts;
// this module handles file-based config only.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Full pi-diff.json schema.
 * All fields are optional — missing fields fall through to env → defaults.
 */
export interface PiDiffJson {
	/** Hunk separator style. */
	sepStyle?: "auto" | "simple" | "gap" | "context" | "metadata";
	/** Show line numbers in gutter. */
	lineNumbers?: boolean;
	/** Diff indicator style on left edge. */
	indicatorStyle?: "bar" | "classic" | "none";
	/** How to render long lines. */
	longLines?: "wrap" | "scroll";
	/** Show file-header with filename and stats. */
	fileHeader?: boolean;
	/** Named diff color preset. */
	theme?: string;
	/** Shiki syntax theme name. */
	shikiTheme?: string;
	/** Per-color hex overrides. */
	colors?: Partial<{
		bgAdd: string;
		bgDel: string;
		bgAddHighlight: string;
		bgDelHighlight: string;
		bgGutterAdd: string;
		bgGutterDel: string;
		bgEmpty: string;
		fgAdd: string;
		fgDel: string;
		fgDim: string;
		fgLnum: string;
		fgRule: string;
		fgStripe: string;
		fgSafeMuted: string;
	}>;
}

// ---------------------------------------------------------------------------
// Module state — singleton cache
// ---------------------------------------------------------------------------

let _cachedConfig: PiDiffJson | null | undefined = undefined; // null = not loaded, undefined = attempted/no-file

/**
 * Load pi-diff.json from project or global paths.
 * Returns {} if neither file exists.
 */
export function loadPiDiffConfig(cwd?: string): PiDiffJson {
	if (_cachedConfig !== undefined) return _cachedConfig ?? {};

	// When a specific cwd is provided (e.g. for testing), only search that path.
	// When omitted, search project root then global.
	const searchPaths = cwd
		? [
				join(cwd, "pi-diff.json"),
				join(cwd, ".pi", "pi-diff.json"),
		  ]
		: [
				join(process.cwd(), "pi-diff.json"),
				join(process.cwd(), ".pi", "pi-diff.json"),
				join(homedir(), ".pi", "agent", "pi-diff.json"),
				join(homedir(), ".pi", "pi-diff.json"),
		  ];

	// Deduplicate by resolving to absolute paths
	const seen = new Set<string>();
	const uniquePaths: string[] = [];
	for (const p of searchPaths) {
		const abs = p.startsWith("/") ? p : join(process.cwd(), p);
		if (!seen.has(abs)) {
			seen.add(abs);
			uniquePaths.push(abs);
		}
	}

	// Priority: project first, then global. Later files extend/override earlier ones.
	let merged: PiDiffJson = {};
	for (const filePath of uniquePaths) {
		try {
			if (!existsSync(filePath)) continue;
			const raw = JSON.parse(readFileSync(filePath, "utf-8")) as PiDiffJson;
			merged = deepMerge(merged, raw);
		} catch {
			// Skip invalid files silently
		}
	}

	_cachedConfig = Object.keys(merged).length > 0 ? merged : null;
	return merged;
}

/**
 * Invalidate the cached config (useful for testing).
 */
export function invalidatePiDiffConfig(): void {
	_cachedConfig = undefined;
}

/**
 * Deep-merge two PiDiffJson objects. Later values win.
 */
function deepMerge(a: PiDiffJson, b: PiDiffJson): PiDiffJson {
	const result: PiDiffJson = { ...a };
	for (const key of Object.keys(b) as (keyof PiDiffJson)[]) {
		const bVal = b[key];
		if (bVal === undefined) continue;
		if (key === "colors" && typeof bVal === "object" && bVal !== null) {
			result.colors = { ...(a.colors as Record<string, string> || {}), ...(bVal as Record<string, string>) };
		} else {
			(result as Record<string, unknown>)[key] = bVal as unknown;
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Config value extractors — return the config value or undefined
// ---------------------------------------------------------------------------

export function configSepStyle(cwd?: string): PiDiffJson["sepStyle"] {
	return loadPiDiffConfig(cwd).sepStyle;
}

export function configLineNumbers(cwd?: string): boolean | undefined {
	return loadPiDiffConfig(cwd).lineNumbers;
}

export function configIndicatorStyle(cwd?: string): PiDiffJson["indicatorStyle"] {
	return loadPiDiffConfig(cwd).indicatorStyle;
}

export function configLongLines(cwd?: string): PiDiffJson["longLines"] {
	return loadPiDiffConfig(cwd).longLines;
}

export function configFileHeader(cwd?: string): boolean | undefined {
	return loadPiDiffConfig(cwd).fileHeader;
}

export function configTheme(cwd?: string): string | undefined {
	return loadPiDiffConfig(cwd).theme;
}

export function configShikiTheme(cwd?: string): string | undefined {
	return loadPiDiffConfig(cwd).shikiTheme;
}

export function configColors(cwd?: string): PiDiffJson["colors"] {
	return loadPiDiffConfig(cwd).colors;
}
