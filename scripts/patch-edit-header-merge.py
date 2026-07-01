#!/usr/bin/env python3
"""Merge edit stats onto call line; remove duplicate result header."""
from pathlib import Path

p = Path(__file__).resolve().parents[1] / "src/index.ts"
t = p.read_text()

# --- maps inside extension ---
if "editHeaderStatsByCallId" not in t:
    t = t.replace(
        "      const cwd = process.cwd();",
        """      const editHeaderStatsByCallId = new Map<
        string,
        { edits: number; diffLines: number; added: number; removed: number }
      >();

      function stashEditHeaderStats(
        toolCallId: string,
        edits: number,
        diffLines: number,
        added: number,
        removed: number,
      ): void {
        if (!toolCallId) return;
        editHeaderStatsByCallId.set(toolCallId, { edits, diffLines, added, removed });
      }

      const cwd = process.cwd();""",
        1,
    )

if "function editCallStatsSuffix" not in t:
    t = t.replace(
        """  function formatBottomPadding(width: number): string {
    return Array.from({ length: TOOL_PREVIEW_BOTTOM_PAD }, () => bgLine("", width)).join("\\n");
  }

  function formatToolTitle""",
        """  function formatBottomPadding(width: number): string {
    return Array.from({ length: TOOL_PREVIEW_BOTTOM_PAD }, () => bgLine("", width)).join("\\n");
  }

  function editEditsCountLabel(edits: number, diffLines: number, theme: PiTheme): string {
    const n = edits === 1 ? "1 edit" : `${edits} edits`;
    return `${n}${diffLineCountLabel(diffLines, theme)}`;
  }

  function editCallStatsSuffix(toolCallId: string | undefined, theme: PiTheme): string {
    const raw = toolCallId ? editHeaderStatsByCallId.get(toolCallId) : undefined;
    if (!raw) return "";
    const count = editEditsCountLabel(raw.edits, raw.diffLines, theme);
    return `${TOOL_RESULT_INDENT}${theme.fg("muted", count)} ${summarize(raw.added, raw.removed)}`;
  }

  function formatToolTitle""",
        1,
    )

# edit renderShell
if 'name: "edit",' in t and "renderShell" not in t[t.find('name: "edit"'): t.find('name: "edit"') + 120]:
    t = t.replace(
        """      pi.registerTool({
        ...origEdit,
        name: "edit",

        async execute(tid: string, params: any, sig: any, upd: any, ctx: any) {""",
        """      pi.registerTool({
        ...origEdit,
        name: "edit",
        renderShell: "self",

        async execute(tid: string, params: any, sig: any, upd: any, ctx: any) {""",
        1,
    )

# stash single edit origEdit
needle = """            const diffData = useFull
              ? parseDiff(operations[0].oldText, operations[0].newText, undefined)
              : diffs[0];
            (result as Record<string, unknown>).details = {
              _type: "editInfo",
              summary: editLine > 0 ? `${summary} at line ${editLine}` : summary,"""
if "stashEditHeaderStats(tid, 1," not in t and needle in t:
    t = t.replace(
        needle,
        """            const diffData = useFull
              ? parseDiff(operations[0].oldText, operations[0].newText, undefined)
              : diffs[0];
            const diffLines = diffData.lines.filter((l) => l.type !== "context").length;
            stashEditHeaderStats(tid, 1, diffLines, diffData.added, diffData.removed);
            (result as Record<string, unknown>).details = {
              _type: "editInfo",
              summary: editLine > 0 ? `${summary} at line ${editLine}` : summary,""",
        1,
    )

# stash multi + renderCall
old_block = """          (result as Record<string, unknown>).details = {
            _type: "multiEditInfo",
            summary: firstEditLine > 0 ? `${summary} at line ${firstEditLine}` : summary,
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
            // Compute the line number for the call preview by reading the
            // file and finding the first oldText. This lets the title show
            // "at line N" even before the edit executes, matching what the
            // result title will show.
            let previewLine = 0;
            try {
              if (fp && existsSync(fp)) {
                const cur = readFileSync(fp, "utf-8");
                const idx = cur.indexOf(operations[0].oldText);
                if (idx >= 0) previewLine = cur.slice(0, idx).split("\\n").length;
              }
            } catch {
              previewLine = 0;
            }
            const loc = previewLine > 0 ? ` ${theme.fg("muted", `at line ${previewLine}`)}` : "";
            text.setText(
              formatToolTitle(
                "edit",
                fp,
                theme,
                termW(),
                `${TOOL_RESULT_INDENT}${theme.fg("muted", summarize(totalAdded, totalRemoved))}${loc}`,
              ),
            );
          } else {
            text.setText(formatToolTitle("edit", fp, theme, termW()));
          }
          return text;
        },"""

new_block = """          const diffLines = merged.lines.filter((l) => l.type !== "context").length;
          stashEditHeaderStats(tid, operations.length, diffLines, merged.added, merged.removed);
          (result as Record<string, unknown>).details = {
            _type: "multiEditInfo",
            summary: firstEditLine > 0 ? `${summary} at line ${firstEditLine}` : summary,
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
          const w = termW();
          let suffix = editCallStatsSuffix(ctx.toolCallId, theme);
          if (!suffix && ctx.argsComplete && operations.length > 0) {
            const { totalAdded, totalRemoved } = summarizeEditOperations(operations);
            const count = editEditsCountLabel(operations.length, totalAdded + totalRemoved, theme);
            suffix = `${TOOL_RESULT_INDENT}${theme.fg("muted", count)} ${summarize(totalAdded, totalRemoved)}`;
          }
          text.setText(formatToolTitle("edit", fp, theme, w, suffix));
          return text;
        },"""

if "editCallStatsSuffix(ctx.toolCallId" not in t:
    if old_block not in t:
        raise SystemExit("edit renderCall block not found")
    t = t.replace(old_block, new_block, 1)

# renderResult multi empty meta
t = t.replace(
    """              if (d?._type === "multiEditInfo") {
                const { editCount, diffLineCount, diff, language } = d;
                const meta = `${editCount} edits${diffLineCountLabel(diffLineCount, theme)}`;
                if (diff) {
                  setDiffPreviewTask(text, "me", meta, diff, language, MAX_PREVIEW_LINES, theme, ctx);
                  return text;
                }
                setToolHeaderText(text, meta, theme);
                return text;
              }""",
    """              if (d?._type === "multiEditInfo") {
                const { diff, language } = d;
                if (diff) {
                  setDiffPreviewTask(text, "me", "", diff, language, MAX_PREVIEW_LINES, theme, ctx);
                  return text;
                }
                setToolHeaderText(text, "", theme);
                return text;
              }""",
    1,
)

p.write_text(t)
print("patched", p)