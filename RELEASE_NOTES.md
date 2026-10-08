# @heyhuynhgiabuu/pi-diff v0.9.3

## Changed

- Pin Pi development SDK packages to `1.1.0`. Host peer dependency ranges are unchanged.
- Add shell-padding regression coverage for tool titles, fully rendered diffs, double padding, and width bounds.

## Fixed

- Align split-view documentation with runtime defaults: 80 renderer columns and 24 code columns per side. Write overwrites can use split view; wrap-heavy previews fall back to unified.
- Clarify that `splitMinWidth` and `splitMinCodeWidth` in `pi-diff.json` currently have no effect. Use `DIFF_SPLIT_MIN_WIDTH` and `DIFF_SPLIT_MIN_CODE_WIDTH` instead.

No tool execution or rendering behavior changes in this release.

## Verification

- 190 tests pass; typecheck, lint, build, and package-content checks pass.
- Real Pi 1.1.0 fullscreen PTY smoke tests pass for wide/narrow terminals and output padding 0/1, using a scripted in-process provider without network model calls.

## npm availability

The GitHub release is prepared separately from npm publication. npm publication is pending the maintainer's manual publish.

After v0.9.3 is published to npm:

```bash
pi install npm:@heyhuynhgiabuu/pi-diff@0.9.3
```
