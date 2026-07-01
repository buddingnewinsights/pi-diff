# Changelog

All notable changes to `@heyhuynhgiabuu/pi-diff` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
