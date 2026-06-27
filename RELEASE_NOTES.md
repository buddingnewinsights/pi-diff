# Release notes

This file is the human-readable release log for `@heyhuynhgiabuu/pi-diff`.
The machine-readable equivalent lives in `CHANGELOG.md`; this file is
what the GitHub release page and `pi install` changelog picker will show.

## 0.6.5 — 2026

### What changed

**Removed the review surface.** The interactive review module
(`/review-diff` slash command, `review_git_diff` Pi tool,
`pi-diff-review` CLI, and all review unit tests including the
comment-related ones) is gone. The remaining `src/review/git.ts`
and `src/review/hunk-preview.ts` are kept as shared
diff-rendering primitives for the main extension.

Review is now delegated to a separate extension such as
[`badlogic/pi-diff-review`](https://github.com/badlogic/pi-diff-review):

```bash
pi install git:https://github.com/badlogic/pi-diff-review
```

Also removed the `resolve_lines` tool (unused since v0.6.4).

**Added an edit guard.** `src/edit-guard.ts` registers a
`tool_call` handler that blocks `edit` calls whose `oldText` is no
longer present in the target file, returning a clear
`VERIFY before EDIT` error. Prevents stale-`oldText` retry loops.

**Fixed the hunk header.** The edit/multiEdit result no longer
shows the diff summary in two places. The location (`at line N`) is
folded into the title summary, so the title reads e.g.
`+9 -4 at line 1944` and the separate stats row is gone for the
single edit. MultiEdit keeps its `N edits / diff lines` stats
because that info is not in pi's native title.

### What you need to do

Nothing. The next `pi install` (or upgrade) picks up 0.6.5
automatically. If you pinned a specific version, run:

```bash
pi install @heyhuynhgiabuu/pi-diff@0.6.5
```

To verify it's working, start pi and look for the
`@heyhuynhgiabuu/pi-diff` line in the extension list. There should
be no errors and edit calls with stale `oldText` should now be
blocked with the `VERIFY before EDIT` message.

### Compatibility

- pi SDK: `>= 0.79.0`
- Node: `>= 20`
- TUI: `>= 0.79.0`

### Verified

- `npm run build` succeeds
- `npm test` 98/98 pass (count went down because of the review
  removal; edit-guard added 5)
- `tsc --noEmit` clean

---

## 0.6.4 — 2025

### Fixed

- **`Cannot find package '@earendil-works/pi-coding-agent'`** on
  `pi install`. `@earendil-works/pi-coding-agent` and
  `@earendil-works/pi-tui` are runtime imports and were incorrectly
  listed under `devDependencies`. They are now in `dependencies` and
  pinned to `^0.79.0` so the npm tarball includes them after
  `npm install --omit=dev` (the default used by `pi install`).

### What you need to do

Nothing. The next `pi install` (or upgrade) picks up 0.6.4
automatically. If you pinned a specific version, run:

```bash
pi install @heyhuynhgiabuu/pi-diff@0.6.4
```

To verify it's working, start pi and look for the
`@heyhuynhgiabuu/pi-diff` line in the extension list. There should be
no `Cannot find package` error.

### Compatibility

- pi SDK: `>= 0.79.0` (uses the new `@earendil-works/pi-coding-agent`
  scope; no longer works with the old `@mariozechner/pi-coding-agent`
  scope that shipped with pi < 0.51)
- Node: `>= 20`
- TUI: `>= 0.79.0` (uses `@earendil-works/pi-tui`)

### Verified

- `npm run build` succeeds
- `npm test` 143/143 pass
- `tsc --noEmit` clean
- `dist/index.js` references `@earendil-works/pi-coding-agent`
- Fresh `npm install` produces a `node_modules/@earendil-works/`
  with both SDK packages present

---

## 0.6.3

See `CHANGELOG.md` for the 0.6.x series history.
