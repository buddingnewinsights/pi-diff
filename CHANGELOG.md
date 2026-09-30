# Changelog

All notable changes to `@heyhuynhgiabuu/pi-diff` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Load Pi SDK modules through static imports and declare them as host-provided peers, including installations without physical SDK copies.
- Remove the unused `pi-server` runtime dependency.

## [0.9.1] — 2026-09-10

### Added

- **Tolerant `apply_patch` input** — accept a JSON-string payload, a single change object, and `edits` sent as a JSON string or a single object, matching Pi's SDK `edit` tolerance.

### Changed

- **Safer `apply_patch` matching** — after exact text, tolerate escaped sequences and Unicode/trailing-whitespace drift; accept a fuzzy match only when it is unique, and refuse non-uniform indentation instead of guessing.
- **Tighter tool spacing** — `write`, `edit`, and `apply_patch` bodies now sit directly under the tool title, with no title/body gap.
- **Themed `apply_patch` header** — resolve the theme's tool background before painting the header.

### Fixed

- **Accurate match failures** — ambiguous `oldText` now reports how many times it matched and asks for more context, instead of a misleading "not found".

## [0.9.0] — 2026-09-09

### Added

- **Structured multi-edit updates** — apply multiple disjoint replacements against one original file with overlap rejection.
- **Adversarial apply_patch coverage** — add regression tests for workspace boundaries, symlinks, encoding, line endings, modes, concurrency, moves, deletes, and previews.

### Changed

- **Workspace-safe paths** — resolve paths within Pi's current workspace and reject traversal outside it or through ancestor symlinks.
- **Transactional mutations** — prepare every change before committing, serialize overlapping operations, preserve file bytes/BOM/EOL/mode metadata, and report best-effort rollback failures.
- **Strict structured input** — validate action-specific fields at both the tool schema and runtime boundary.
- **Accurate patch feedback** — generate structured diffs and render previewable changes from mixed add/update/delete batches.

### Fixed

- **Unsafe source updates** — reject ambiguous or overlapping matches, invalid UTF-8 files, and add/move collisions instead of silently rewriting or clobbering files.

## [0.8.2] — 2026-09-09

### Fixed

- **Tool rendering spacing** — normalize `write`, `edit`, and `apply_patch` previews around Pi's default tool shell: one host-provided leading space, no redundant edge padding, one title/body separator, and one trailing shell pad.

### Changed

- **Pi SDK dependencies** — update direct Pi SDK dependencies to **0.85.0**.

### Added

- **Renderer regression coverage** — test tool titles, create previews, diff bodies, non-diff results, and errors through the default host shell.

## [0.8.1] — 2026-08-23

### Fixed

- **Extension silently disabled under pi's installer** — v0.8.0 declared the Pi SDK packages as peer dependencies (adopted from PR #3), but pi's extension installer never installs peers, so `import("@earendil-works/pi-coding-agent")` failed inside `<project>/.pi/npm` installs and the whole extension degraded to plain built-in tools: no wrapping, no Shiki previews. Pi SDK packages are direct dependencies again, upgraded from 0.82 to **0.84.2** to match current pi.

## [0.8.0] — 2026-08-11

### Changed

- **Strict `edit` execution** — delegate matching, validation, serialization, BOM/EOL preservation, and file writes to Pi SDK 0.82 while retaining pi-diff's structured inputs and renderer.
- **Accurate edit previews** — render Pi's returned unified patch instead of reconstructing previews from requested text.
- **Pi host dependencies** — declare Pi core packages as peers, align development dependencies with Pi 0.82.0, and require `@earendil-works/pi-coding-agent` 0.82.x.

### Fixed

- Reject ambiguous overlapping edit matches, edits that overlap or do not match the original file, and malformed unified patches without partially mutating files or rendering misleading previews.
- Preserve CRLF and BOM content during fuzzy edits.
- Clean generated output before builds so removed modules cannot leak into release packages.

## [0.7.6] — 2026-07-21

### Added

- **Tool configuration** — `pi-diff.json` now supports `disabledTools`, allowing users to omit `write`, `edit`, or `apply_patch`. Disabled `write` and `edit` use Pi's built-ins; disabled `apply_patch` is unavailable.

### Fixed

- **`apply_patch` safety** — preflight all changes, reject clobbering or unsafe source matches, preserve file modes and CRLF, and roll back committed changes if a later commit fails.
- **`apply_patch` errors** — failed patch results use the theme error foreground as well as the error background.
- **Tool output defaults** — Pi's global collapsed-by-default setting now applies to non-pi-diff tools while pi-diff previews remain visible for `write`, `edit`, and `apply_patch`.

## [0.7.5] — 2026-07-11

### Changed

- **Tool headers** — prefix `write`, `edit`, and `apply_patch` headers with `←`, align header paths with the tool-title color, and refine result spacing.
- **Failure rendering** — show failed `write`, `edit`, and `apply_patch` headers with the error foreground and background while preserving error-message styling.
- **Code quality** — resolve the repository's Biome lint violations.

## [0.7.4] — 2026-07-09

### Fixed

- **Published package contents** — include all built `dist/` artifacts in the npm package so runtime imports like `./core/apply-patch.js` are present after install.
- **Packaging safety** — replace the hand-maintained file allowlist with `dist/` packaging to prevent future missing build-module releases.

## [0.7.3] — 2026-07-08

### Added

- **`apply_patch` tool** — atomic multi-file add/update/delete/move operations with structured JSON input.

### Changed

- **Tool surface** — remove `hashline_read` / `hashline_edit` in favor of `read`, `edit`, and `apply_patch`.
- **`edit` execution path** — simplify back to single-file text replacement using the shared replace matcher.
- **Diff previews** — refine `write`, `edit`, and `apply_patch` rendering with compact gutters, safer async preview cache keys, and tool-specific header spacing.
- **`apply_patch` summary** — shorten multi-file headers to show the first path followed by `+n more`.

### Fixed

- **Preview backgrounds** — prevent header-only background styling from leaking into diff bodies after ANSI resets.
- **`edit` spacing** — restore the intended one-line top pad plus one-column left indent for header and diff body previews.

## [0.7.1] — 2026-07-03

### Fixed

- **npm package** — include compiled hashline modules in `package.json` `files` (`dist/hashline.js`, `dist/core/hashline-edit.js`, `dist/core/hashline-execute.js`, `dist/core/text-encoding.js`). Fixes extension load error `Cannot find module './hashline.js'`.

## [0.7.0] — 2026-07-03

### Added

- **`hashline_read` / `hashline_edit` tools** — content-anchored edits (xxhash-wasm), strict `E_STALE_ANCHOR` / overlap / range errors with `hashline_read` reread hints.
- **Read format** — `LINE│HASH│content` (1-based line numbers, padded).
- **`dryRun`** on `hashline_edit` and on **`edit`** when using `hashlineChanges`.
- **BOM + CRLF/LF preservation** on hashline writes (`src/core/text-encoding.ts`).
- **Shared `runHashlineEdit`** — single read via `rawUtf8`, `finalRaw` for diffs.
- **`edit` `hashlineChanges`** path delegates to shared executor; legacy `oldText`/`newText` unchanged.
- **`hashline_edit` call stats** — `N diff lines` + themed `+x -y`.
- **`scripts/analyze-hashline-edits.py`** — session JSONL stats for hashline tools.
- **ADR-001** — hashline vs upstream Pi `edit` (`.pi/artifacts/DECISIONS.md`).

### Changed

- **Hashline TUI** — `renderCall` titles; no duplicate path in collapsed `hashline_read` result; no leading `\n` on hashline read/edit result text; `callTitleBottomPad: 0` for single gap under call title.
- **Header helpers** — `formatToolFrameHeader` consolidation for write/edit/hashline.

### Documentation

- README **Design notes** + CHANGELOG pointer to ADR-001.

## [0.6.10] — 2026-07-02

### Changed

- **Default expanded tool output** — `session_start` calls `setToolsExpanded(true)` so write/edit diffs are not left collapsed when pi-pretty sets `toolOutputExpanded: false`.
- **Write overwrite** — `_type: "diff"` always renders full diff preview (removed collapsed summary-only branch).
- **Themed +X -Y on call lines** — `summarizeThemed` + `writeCallStatsSuffix` / stash on write execute; edit stats use theme `toolDiffAdded` / `toolDiffRemoved` on headers.

### Documentation

- **ADR-001** — [`.pi/artifacts/DECISIONS.md`](.pi/artifacts/DECISIONS.md): pi-diff hashline path vs upstream Pi `edit` philosophy (opt-in anchors, explicit errors, not a core replacement). README links to the same doc.

## [0.6.9] — 2026-07-02

### Changed

- **Write/edit call headers** — `formatToolCallHeader` adds bottom padding under title rows; write/create streaming uses padded headers.
- **Edit multi-edit stats** — `editHeaderStatsByCallId` / `editCallStatsSuffix`; `N edits (M diff lines) +X -Y` on the call line; `multiEditInfo` result omits duplicate stats meta row.
- **New-file write (`_type: new`)** — default expanded preview; `✓ new file` and Shiki body on `toolSuccessBg` (`bgLine` / `padDiffBody`); no extra leading indent on the success line.
- **`renderShell: "self"`** on patched write and edit tools.

## [0.6.8] — 2026-07-01

### Fixed

- **npm package**: include `dist/collapsed-hint.js` in published tarball (`package.json` `files`); fixes `Cannot find module './collapsed-hint.js'` at load time.

## [0.6.7] — 2026-07-01

### Removed

- Dead `src/expand.ts` and no-op `setConfig({ toolOutputExpanded })` registration (Pi 0.80 uses `SessionContext.setToolsExpanded` only).

## [0.6.6] — 2026-07-01

### Changed

- **Pi 0.80**: `@earendil-works/pi-coding-agent` and `pi-tui` at `^0.80.0`; removed self-dependency on `@heyhuynhgiabuu/pi-diff`.
- **Tool output layout**: one leading space on tool title (`TOOL_HEADER_LEFT_PAD`); diff body flush (`DIFF_BODY_LEFT_PAD` 0); wrapped lines use `TOOL_RESULT_INDENT`.

### Added

- **Write overwrite** collapse: `+N -M` summary when block collapsed (`ctrl+o to expand`); **new file** collapse unchanged.
- **Edit / multi-edit** always show unified diff (not gated on `ctx.expanded`). Removed no-op `setConfig({ toolOutputExpanded })` hook.

## [0.6.5] — 2026

### Removed

- **`resolve_lines` tool** — unused after the v0.6.4 cut.
- **Review surface** — the entire interactive review module
  (`src/review/command.ts`, `interactive.ts`, `session.ts`, `tui.ts`,
  `model.ts`, `hunk-bridge.ts`, `export.ts`, `file-preview.ts`,
  `prompt.ts`). This includes:
  - the `/review-diff` slash command
  - the `review_git_diff` Pi tool
  - the `pi-diff-review` CLI binary (`src/cli.ts`)
  - all review unit tests (including the comment-related ones
    in `session.test.ts`, `model.test.ts`, `tui.test.ts`,
    `interactive.test.ts`, `file-preview.test.ts`, and
    `index.review-command.test.ts`)
  - the `prompts/review-diff-agent.md` prompt
  - the `pi-diff-review` bin entry and related dist globs in
    `package.json`
  - the `## Git Review in Pi TUI` and `## Review Export CLI`
    sections in `README.md`

  Review is now delegated to a separate extension such as
  [`badlogic/pi-diff-review`](https://github.com/badlogic/pi-diff-review)
  (installed via `pi install git:https://github.com/badlogic/pi-diff-review`).

  The two remaining `src/review/git.ts` and `src/review/hunk-preview.ts`
  files are kept — they provide the shared diff-rendering primitives
  (`renderSplit`, `renderUnified`, etc.) used by the main extension for
  write/edit tool previews. They were renamed in the source tree to
  clarify that boundary; the exports are unchanged.

### Added

- **Edit guard** (`src/edit-guard.ts`) — a `tool_call` event handler
  that blocks `edit` calls whose `oldText` is no longer present in
  the target file, returning a clear `VERIFY before EDIT` error
  directing the model to re-read the file. Prevents stale-`oldText`
  retry loops. Has 5 unit tests (`src/edit-guard.test.ts`).

### Fixed

- **Hunk header duplicate summary** — the edit/multiEdit result
  was showing the diff summary (`+9 -4`) in two places at once: in
  pi's native tool header and again in pi-diff's hunk header. The
  hunk header now folds the location (`at line N`) into the title
  summary, so the title reads `+9 -4 at line 1944` and the separate
  stats row is gone (single edit only; multiEdit keeps its
  `N edits / diff lines` stats because that's info pi's title
  doesn't show).
- **At-line coverage** — the previous fold-location-into-title fix
  only applied to one of four code paths in the edit tool's execute
  callback. All four (`editInfo` × 2, `multiEditInfo` × 2) now
  produce the same title format.
- **Call preview title** — the `at line N` suffix was only
  appearing in the result title. The call preview (rendered by
  `renderCall`, shown while the edit is being dispatched) now
  also shows the location, by reading the file once and locating
  the first `oldText` before the SDK tool executes.

### Docs

- README rewritten to match the rollback-to-v0.6.4 codebase:
  - File tree updated to show `core/`, `review/`, `edit-guard.ts`
  - "Key internals" table now lists the actual `__testing` exports
    (`parseDiff`, `parsePatchFiles`, `resolveSepStyle`,
    `getSepStyle`, `computeHunkBlocks`, `renderSplit`,
    `renderUnified`, `normalizeShikiContrast`)
  - Extension example uses `ExtensionAPI` (not `any`) and shows
    the `registerEditGuard(pi)` call
  - Events list updated (`tool_call` instead of
    `before_tool_call`)

### Verified

- `npm run build` succeeds
- `npm test` 98/98 pass (test count went down because of the
  review-tool removal; edit-guard added 5)
- `tsc --noEmit` clean

## [0.6.4] — 2025

### Fixed

- `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` moved
  from `devDependencies` to `dependencies`. They are runtime imports, so
  the npm-published version was missing them after
  `npm install --omit=dev` (the default used by `pi install`).

  This caused the following load error in pikit (and any project using
  `pi install` to consume this package):

  ```
  pi loading extension "@heyhuynhgiabuu/pi-diff"
    Cannot find package '@earendil-works/pi-coding-agent'
  ```

### Changed

- Pinned `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`
  to `^0.79.0` (was `*`).

### Verified

- `npm run build` succeeds
- `npm test` 143/143 pass
- `tsc --noEmit` clean
- The dist `dist/index.js` references `@earendil-works/pi-coding-agent`
  (the correct, current package name)

## [0.6.3] and earlier

See the git history: `git log --oneline -- CHANGELOG.md`.

[0.6.5]: https://github.com/buddingnewinsights/pi-diff/releases/tag/v0.6.5
[0.6.4]: https://github.com/buddingnewinsights/pi-diff/releases/tag/v0.6.4
[Keep a Changelog]: https://keepachangelog.com/
[Semantic Versioning]: https://semver.org/

> **Note:** v0.6.5 had a broken `files` array in `package.json` that
> omitted `dist/edit-guard.*`, causing the published npm tarball
> to fail with `Cannot find module './edit-guard.js'`. v0.6.6
> re-publishes with the file array fixed.
