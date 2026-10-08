# pi-diff

[![npm version](https://img.shields.io/npm/v/@heyhuynhgiabuu/pi-diff)](https://www.npmjs.com/package/@heyhuynhgiabuu/pi-diff)
[![GitHub release](https://img.shields.io/github/v/release/buddingnewinsights/pi-diff)](https://github.com/buddingnewinsights/pi-diff/releases/latest)

A [pi](https://pi.dev) extension that replaces the default `write` and `edit` tool output with **Shiki-powered, syntax-highlighted diffs** — side-by-side split view, unified stacked view, and word-level change emphasis, all rendered directly in your terminal.

> **Status:** Early release.

### Unified view — stacked single-column diff

<img width="700" alt="pi-diff unified view" src="https://github.com/buddingnewinsights/pi-diff/raw/main/media/unified.png" />

### Split view — side-by-side comparison

<img width="700" alt="pi-diff split view" src="https://github.com/buddingnewinsights/pi-diff/raw/main/media/split.png" />

## Features

- **Syntax-highlighted diffs** — full Shiki grammar highlighting (190+ languages) composited with diff background colors
- **Split view** — side-by-side comparison for `edit` and `write` overwrite previews; falls back to unified on narrow terminals, unbalanced changes, or wrap-heavy hunks
- **Unified view** — stacked single-column layout; the fallback when split view's thresholds are not met
- **Word-level emphasis** — changed characters get brighter backgrounds so you see exactly what changed
- **New file preview** — syntax-highlighted preview when creating files
- **Adaptive layout** — auto-detects terminal width; wraps intelligently on wide terminals, truncates on narrow ones
- **LRU cache** — singleton Shiki highlighter with 192-entry cache for fast re-renders
- **Large diff fallback** — gracefully degrades (skips highlighting, still shows diff structure) for files > 80k chars
- **Fully customizable** — every color and threshold is overridable via environment variables
- **Strict edit safety** — delegates matching, uniqueness, overlap checks, mutation queues, aborts, BOM, and EOL preservation to Pi's SDK edit tool

## Install

```bash
pi install npm:@heyhuynhgiabuu/pi-diff
```

Latest release: https://github.com/buddingnewinsights/pi-diff/releases/latest

Or load directly for development:

```bash
pi -e ./src/index.ts
```

## How It Works

pi-diff wraps the built-in `write` and `edit` tools from the pi SDK, including single-edit and multi-edit `edit` calls. When the agent writes or edits a file:

1. **Before the write** — reads the existing file content
2. **Delegates** to the original SDK tool (file is actually written)
3. **After the write** — computes a structured diff between old and new content
4. **Renders** the diff with syntax highlighting and word-level emphasis

For `edit` calls, Pi's SDK performs matching, uniqueness and overlap validation, mutation queueing, and the file write. pi-diff adapts the SDK's returned unified patch into its syntax-highlighted renderer, so the preview reflects the actual matched source rather than the requested text.

### `apply_patch` safety contract

`apply_patch` remains a separate structured JSON tool for multi-file add, update, delete, and move operations. Paths are resolved relative to Pi's current workspace and must remain inside it; ancestor symlinks are rejected. Updates may use one `oldText`/`newText` replacement or an `edits` array of disjoint replacements matched against the original file. Matching is exact first, then tolerates escaped sequences and Unicode/trailing-whitespace drift; a match is accepted only when it is unique, and ambiguous or missing `oldText` fails with a specific error.

All changes are prepared before the first commit. A commit failure triggers reverse-order rollback, but filesystem rollback is necessarily best effort; callers should treat a failed result as requiring verification. Existing files are never intentionally clobbered by `add` or `move`, and invalid UTF-8 files are rejected rather than rewritten as text.

The rendering pipeline:

```
Old content ──┐
              ├── diff (structuredPatch) ── parse ── highlight (Shiki → ANSI)
New content ──┘                                          │
                                                         ├── inject diff bg
                                                         ├── inject word-level bg
                                                         └── wrap/fit to terminal
```

### Views

| View        | Used by      | Description                                                                                                                                                       |
| ----------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Split**   | `edit`, `write` (overwrites), `apply_patch` updates | Side-by-side with old on left, new on right. Diagonal stripes fill empty slots. Used only when the renderer width is at least 80 columns (`DIFF_SPLIT_MIN_WIDTH`), each code column is at least 24 columns (`DIFF_SPLIT_MIN_CODE_WIDTH`), the preview has both removed and added lines within a 2× ratio, fewer than 10 lines would wrap, and less than 35% of lines would wrap. Otherwise falls back to unified. |
| **Unified** | Fallback for the same previews | Single column with `+`/`-` gutter. Compact, works at any terminal width. |

The renderer width is the available tool area after Pi applies output padding (`0` or `1` on each side). In a full-width tool area, padding 1 leaves an 82-column terminal with 80 renderer columns; narrower panes can reduce this further. Meeting the width threshold alone does not guarantee split: the other checks above still apply. New-file previews use their own view and are not split.

Both views show:

- Colored border bars (`▌`) for changed lines
- Line numbers in the gutter
- Hunk separators (`··· N unmodified lines ···`)
- Word-level emphasis on paired add/del lines

## Configuration

### Disable pi-diff tools

Add `disabledTools` to `pi-diff.json` to omit pi-diff tools. Disabling `write` or `edit` leaves Pi's built-in tool available; disabling `apply_patch` removes that custom tool.

```json
{
  "disabledTools": ["apply_patch"]
}
```

See [CONFIG.md](CONFIG.md) for the full `pi-diff.json` reference.

### Diff Theme Presets

pi-diff ships with built-in theme presets optimized for different terminal backgrounds. Add to your `.pi/settings.json`:

```json
{
  "theme": "dark",
  "diffTheme": "midnight"
}
```

| Preset     | Best for                         | Description                                               |
| ---------- | -------------------------------- | --------------------------------------------------------- |
| `default`  | Dark theme bases (~`#1e1e2e`)    | Original pi-diff colors — balanced contrast               |
| `midnight` | Pure black (`#000000`) terminals | Subtle tints that don't overwhelm on black                |
| `subtle`   | Any dark theme                   | Minimal backgrounds — barely-there tints for a clean look |
| `neon`     | Low-contrast displays            | Higher contrast backgrounds for better visibility         |

### Per-Color Overrides

Override individual diff colors in `.pi/settings.json` using hex `#RRGGBB` values:

```json
{
  "theme": "dark",
  "diffTheme": "midnight",
  "diffColors": {
    "bgAdd": "#0d1a12",
    "bgDel": "#1a0d0d",
    "bgAddHighlight": "#1a3825",
    "bgDelHighlight": "#381a1a",
    "bgGutterAdd": "#091208",
    "bgGutterDel": "#120908",
    "bgEmpty": "#080808",
    "fgAdd": "#64b478",
    "fgDel": "#c86464",
    "fgDim": "#404040",
    "fgLnum": "#505050",
    "fgRule": "#282828",
    "fgStripe": "#1e1e1e",
    "fgSafeMuted": "#8b949e",
    "shikiTheme": "github-dark"
  }
}
```

`diffColors` overrides take priority over `diffTheme` presets, so you can start from a preset and tweak individual colors.

### Auto-Derive (Default Behavior)

When no `diffTheme` or `diffColors` is set, pi-diff **automatically derives** background colors from your pi theme's diff foreground colors and tool-state backgrounds. Added/context surfaces use `toolSuccessBg`; removed surfaces use `toolErrorBg`. This ensures diffs look good with any pi theme and terminal background — no configuration needed.

The auto-derive uses different intensity levels:

- **Line backgrounds**: 8–10% of the theme's diff fg color mixed into the matching tool-state background (subtle tint)
- **Word highlights**: 20–22% (more visible for changed characters)
- **Gutters**: 5–6% (subtler than line backgrounds)

### Color Resolution Order

For each color, pi-diff checks (highest priority first):

1. **Environment variable** — e.g. `DIFF_BG_ADD="#1a3320"` (backward compatible)
2. **`diffColors`** from `.pi/settings.json` (per-color hex overrides)
3. **`diffTheme` preset** from `.pi/settings.json` (named preset bundle)
4. **Auto-derived** from pi theme's `toolDiffAdded`/`toolDiffRemoved` colors
5. **Hardcoded fallback** (original defaults)

### Environment Variables

All settings are also controllable via environment variables. Add them to your shell profile or `.envrc`:

### Theme

| Variable     | Default       | Description                                                            |
| ------------ | ------------- | ---------------------------------------------------------------------- |
| `DIFF_THEME` | `github-dark` | Shiki theme name (e.g., `dracula`, `one-dark-pro`, `catppuccin-mocha`) |

### Colors

Override any diff color with hex `#RRGGBB` format:

| Variable             | Default   | Description                                 |
| -------------------- | --------- | ------------------------------------------- |
| `DIFF_BG_ADD`        | `#162620` | Background for added lines                  |
| `DIFF_BG_DEL`        | `#2d1919` | Background for removed lines                |
| `DIFF_BG_ADD_HL`     | `#234b32` | Word-level emphasis on added text           |
| `DIFF_BG_DEL_HL`     | `#502323` | Word-level emphasis on removed text         |
| `DIFF_BG_GUTTER_ADD` | `#12201a` | Gutter background for added lines           |
| `DIFF_BG_GUTTER_DEL` | `#261616` | Gutter background for removed lines         |
| `DIFF_FG_ADD`        | `#64b478` | Foreground for `+` signs and add indicators |
| `DIFF_FG_DEL`        | `#c86464` | Foreground for `-` signs and del indicators |

### Layout

| Variable                    | Default | Description                                 |
| --------------------------- | ------- | ------------------------------------------- |
| `DIFF_SPLIT_MIN_WIDTH`      | `80`    | Minimum renderer width (terminal columns minus 2 × output padding) to use split view |
| `DIFF_SPLIT_MIN_CODE_WIDTH` | `24`    | Minimum code columns per side in split view |

`splitMinWidth` and `splitMinCodeWidth` in `pi-diff.json` are not read by pi-diff yet; use the environment variables above. See [CONFIG.md](CONFIG.md).

### Example `.envrc`

```bash
# Use a different Shiki theme
export DIFF_THEME="catppuccin-mocha"

# Brighter add backgrounds
export DIFF_BG_ADD="#1a3a25"
export DIFF_BG_ADD_HL="#2d6040"

# Allow split view on narrower terminals (default 80)
export DIFF_SPLIT_MIN_WIDTH=60
```

## Architecture

```
src/
├── index.ts            # Extension entry point — wraps write/edit tools with diff rendering
├── core/               # Pure data layer: diff parsing, conflict detection, line resolution
│   ├── config.ts
│   ├── conflicts.ts
│   ├── diff.ts         # parseDiff, parsePatchFiles, resolveSepStyle
│   ├── replace.ts      # conservative apply_patch matcher and legacy helpers
│   ├── resolve-lines.ts
│   └── *.test.ts
└── review/             # Shared diff-rendering primitives used by the main extension
    ├── git.ts          # read git diffs from disk (execFileSync)
    └── hunk-preview.ts # renderSplit, renderUnified, theme helpers (re-exported via __testing)
```

### Key internals

All listed symbols are exposed under the `__testing` export for unit tests:

| Symbol                     | Source                  | Purpose                                                                 |
| -------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| `parseDiff()`              | `core/diff.ts`          | Convert old/new content to structured `DiffLine[]` (added/removed/chars) |
| `parsePatchFiles()`        | `core/diff.ts`          | Parse a full `git apply` patch into per-file diff objects               |
| `resolveSepStyle()`        | `core/diff.ts`          | Pick the per-side separator style (` │ ` vs `╱`) for split view         |
| `getSepStyle()`            | `review/hunk-preview.ts`| Same as above for the shared rendering layer                            |
| `computeHunkBlocks()`      | `review/hunk-preview.ts`| Build add/remove/modify line blocks with column ranges for split view   |
| `renderSplit()`            | `review/hunk-preview.ts`| Side-by-side renderer with diagonal stripe fillers                      |
| `renderUnified()`          | `review/hunk-preview.ts`| Stacked single-column renderer                                          |
| `normalizeShikiContrast()` | `review/hunk-preview.ts` | Lighten/darken Shiki output to match the surrounding TUI theme        |

### Rendering constants

| Constant            | Value  | Description                                |
| ------------------- | ------ | ------------------------------------------ |
| `MAX_PREVIEW_LINES` | 60     | Max lines in edit preview (split view)     |
| `MAX_RENDER_LINES`  | 150    | Max lines in write result (unified view)   |
| `MAX_HL_CHARS`      | 80,000 | Skip syntax highlighting above this        |
| `CACHE_LIMIT`       | 192    | LRU cache entries for highlighted blocks   |
| `WORD_DIFF_MIN_SIM` | 0.15   | Minimum similarity for word-level emphasis |

## Exports

The extension exports a `__testing` object for unit testing:

```typescript
import { __testing } from "@heyhuynhgiabuu/pi-diff";

const { parseDiff, renderSplit, renderUnified, normalizeShikiContrast } =
  __testing;
```

## Development

```bash
git clone https://github.com/buddingnewinsights/pi-diff.git
cd pi-diff
npm install
npm run typecheck   # TypeScript validation
npm run lint        # Biome linting
npm test            # Run tests
```

### Load in pi for testing

```bash
# From the pi-diff directory
pi -e ./src/index.ts

# Or install globally
pi install .
```

## How pi Extensions Work

pi-diff is a **pi extension** — a TypeScript file that exports a default function receiving the pi API:

```typescript
export default function piDiffExtension(pi: ExtensionAPI): void {
  // Wrap the built-in write/edit tools with diff rendering
  const origWrite = createWriteTool(cwd);
  const origEdit = createEditTool(cwd);

  pi.registerTool({
    ...origWrite,
    name: "write",
    execute: async (...) => { /* wrap + diff */ },
    renderCall: (...) => { /* preview */ },
    renderResult: (...) => { /* render diff */ },
  });

}
```

Extensions can:

- **Register tools** — `pi.registerTool(definition)`
- **Listen to events** — `pi.on("session_start" | "input" | "tool_call" | "session_shutdown" | ...)`
  - `tool_call` handlers can `block: true` to prevent the call from running
- **Register commands** — `pi.registerCommand("/name", handler)`

See the [pi docs](https://pi.dev) for the full extension API.

## Design notes

How **hashline** (`hashline_read`, `hashline_edit`, `edit` `hashlineChanges`) relates to Pi’s stock **`edit`** tool (exact `edits[]`, bounded fuzzy match, loud failures) is documented in [`.pi/artifacts/DECISIONS.md`](.pi/artifacts/DECISIONS.md) (ADR-001). Summary: stock `edit` stays the portable default; hashline is an opt-in strict anchor path for agents that adopt it.

## License

MIT — [huynhgiabuu](https://github.com/buddingnewinsights)
