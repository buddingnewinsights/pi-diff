import { beforeEach, describe, expect, it } from "vitest";

import { computeHunkBlocks, type HunkMeta, parseDiff, parsePatchFiles, resolveSepStyle, getSepStyle, sepLabelUnified, sepLabelSplit } from "./diff.js";

// ---------------------------------------------------------------------------
// parseDiff
// ---------------------------------------------------------------------------

describe("parseDiff", () => {
	it("counts added and removed lines", () => {
		const parsed = parseDiff("one\ntwo\nthree\n", "one\nTWO\nthree\nfour\n");

		expect(parsed.added).toBe(2);
		expect(parsed.removed).toBe(1);
		expect(parsed.lines.map((line) => line.type)).toContain("add");
		expect(parsed.lines.map((line) => line.type)).toContain("del");
	});

	it("preserves old and new line numbers", () => {
		const parsed = parseDiff("a\nb\nc\n", "a\nb changed\nc\n");
		const removed = parsed.lines.find((line) => line.type === "del");
		const added = parsed.lines.find((line) => line.type === "add");

		expect(removed).toMatchObject({ oldNum: 2, newNum: null, content: "b" });
		expect(added).toMatchObject({ oldNum: null, newNum: 2, content: "b changed" });
	});

	it("emits first-hunk sep with hunkMeta at position 0", () => {
		const parsed = parseDiff("a\nb\nc\n", "a\nB\nc\n");
		const first = parsed.lines[0];
		expect(first.type).toBe("sep");
		expect(first.hunkMeta).toBeDefined();
		expect(first.hunkMeta!.oldStart).toBe(1);
		expect(first.hunkMeta!.oldLines).toBe(3);
		expect(first.hunkMeta!.newStart).toBe(1);
		expect(first.hunkMeta!.newLines).toBe(3);
	});

	it("emits hunkMeta on between-hunk separators", () => {
		// Multi-hunk diff: change lines 1-2 and lines 7-8 with 1 context → 2 hunks
		const oldContent = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n";
		const newContent = "A\nB\nc\nd\ne\nf\nG\nH\ni\nj\nk\n";
		const parsed = parseDiff(oldContent, newContent, 1);

		const seps = parsed.lines.filter((l) => l.type === "sep");
		expect(seps.length).toBe(2);
		for (const sep of seps) {
			expect(sep.hunkMeta).toBeDefined();
		}
		expect(seps[0].hunkMeta!.oldStart).toBe(1);
		expect(seps[1].hunkMeta!.oldStart).toBe(6);
	});

	it("does not set context on hunkMeta for programmatic diffs", () => {
		const parsed = parseDiff("a\nb\nc\n", "a\nB\nc\n");
		const first = parsed.lines[0];
		expect(first.hunkMeta?.context).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// parsePatchFiles
// ---------------------------------------------------------------------------

describe("parsePatchFiles", () => {
	it("parses a simple single-file unified diff", () => {
		const patch = [
			"--- a/test.ts",
			"+++ b/test.ts",
			"@@ -1,3 +1,4 @@",
			" a",
			"-b",
			"+B",
			"+c",
		].join("\n");

		const result = parsePatchFiles(patch);
		expect(result).toHaveLength(1);
		expect(result[0].added).toBe(2);
		expect(result[0].removed).toBe(1);

		const types = result[0].lines.map((l) => l.type);
		expect(types[0]).toBe("sep"); // first-hunk sep
		expect(types).toContain("add");
		expect(types).toContain("del");
		expect(types).toContain("ctx");
	});

	it("parses a diff with git --diff header", () => {
		const patch = [
			"diff --git a/test.ts b/test.ts",
			"index abc..def 100644",
			"--- a/test.ts",
			"+++ b/test.ts",
			"@@ -1,3 +1,3 @@",
			" a",
			"-b",
			"+B",
		].join("\n");

		const result = parsePatchFiles(patch);
		expect(result).toHaveLength(1);
	});

	it("extracts function context from hunk header", () => {
		const patch = [
			"--- a/test.ts",
			"+++ b/test.ts",
			"@@ -10,6 +10,6 @@ function helloWorld() {",
			" const x = 1;",
			"-const y = 2;",
			"+const y = 3;",
		].join("\n");

		const result = parsePatchFiles(patch);
		const firstSep = result[0].lines.find((l) => l.type === "sep");
		expect(firstSep?.hunkMeta?.context).toBe("function helloWorld() {");
	});

	it("parses multi-file diffs", () => {
		const patch = [
			"diff --git a/a.ts b/a.ts",
			"--- a/a.ts",
			"+++ b/a.ts",
			"@@ -1,1 +1,1 @@",
			"-a",
			"+A",
			"diff --git a/b.ts b/b.ts",
			"--- a/b.ts",
			"+++ b/b.ts",
			"@@ -1,1 +1,2 @@",
			" b",
			"+c",
		].join("\n");

		const result = parsePatchFiles(patch);
		expect(result).toHaveLength(2);
		expect(result[0].removed).toBe(1);
		expect(result[0].added).toBe(1);
		expect(result[1].removed).toBe(0);
		expect(result[1].added).toBe(1);
	});

	it("returns empty array for empty input", () => {
		expect(parsePatchFiles("")).toEqual([]);
		expect(parsePatchFiles("   ")).toEqual([]);
	});

	it("handles hunk headers without line count (count=1 implied)", () => {
		const patch = [
			"--- a/test.ts",
			"+++ b/test.ts",
			"@@ -1 +1,2 @@",
			" a",
			"+b",
		].join("\n");

		const result = parsePatchFiles(patch);
		expect(result).toHaveLength(1);
		expect(result[0].added).toBe(1);

		const sep = result[0].lines.find((l) => l.type === "sep");
		expect(sep?.hunkMeta?.oldLines).toBe(1);
		expect(sep?.hunkMeta?.newLines).toBe(2);
	});

	it("parses multi-hunk diffs with correct hunk metadata per hunk", () => {
		const patch = [
			"--- a/test.ts",
			"+++ b/test.ts",
			"@@ -1,2 +1,2 @@",
			" a",
			"-b",
			"+B",
			"@@ -5,3 +5,4 @@",
			" e",
			"-f",
			"+F",
			"+g",
		].join("\n");

		const result = parsePatchFiles(patch);
		const seps = result[0].lines.filter((l) => l.type === "sep");
		expect(seps).toHaveLength(2);
		expect(seps[0].hunkMeta?.oldStart).toBe(1);
		expect(seps[0].hunkMeta?.oldLines).toBe(2);
		expect(seps[1].hunkMeta?.oldStart).toBe(5);
		expect(seps[1].hunkMeta?.oldLines).toBe(3);
	});

	it("ignores no-newline markers", () => {
		const patch = [
			"--- a/test.ts",
			"+++ b/test.ts",
			"@@ -1,2 +1,2 @@",
			" a",
			"-b",
			"\\ No newline at end of file",
			"+B",
			"\\ No newline at end of file",
		].join("\n");

		const result = parsePatchFiles(patch);
		expect(result[0].lines.filter((l) => l.content === "")).toHaveLength(1); // only the sep
	});
});

// ---------------------------------------------------------------------------
// Separator label styles
// ---------------------------------------------------------------------------

describe("sepLabelUnified", () => {
	const makeMeta = (ctx?: string): HunkMeta => ({ oldStart: 10, oldLines: 6, newStart: 10, newLines: 8, context: ctx });

	it("auto style shows context + gap when both available", () => {
		expect(sepLabelUnified("auto", makeMeta("fn()"), 5)).toBe(" fn() — +5 lines ");
	});

	it("auto style shows context without gap", () => {
		expect(sepLabelUnified("auto", makeMeta("fn()"), null)).toBe(" fn() ");
	});

	it("auto style shows gap only", () => {
		expect(sepLabelUnified("auto", makeMeta(), 5)).toBe(" +5 lines ");
	});

	it("auto style shows ellipsis when nothing available", () => {
		expect(sepLabelUnified("auto", makeMeta(), null)).toBe("···");
	});

	it("simple style always shows ellipsis", () => {
		expect(sepLabelUnified("simple", makeMeta("fn()"), 5)).toBe("···");
		expect(sepLabelUnified("simple", makeMeta(), null)).toBe("···");
	});

	it("gap style shows gap", () => {
		expect(sepLabelUnified("gap", makeMeta("fn()"), 5)).toBe(" 5 unmodified lines ");
	});

	it("gap style falls back to ellipsis", () => {
		expect(sepLabelUnified("gap", makeMeta(), null)).toBe("···");
	});

	it("context style shows context", () => {
		expect(sepLabelUnified("context", makeMeta("fn()"), 5)).toBe(" fn() ");
	});

	it("context style falls back to gap", () => {
		expect(sepLabelUnified("context", makeMeta(), 5)).toBe(" 5 unmodified lines ");
	});

	it("metadata style shows full header", () => {
		expect(sepLabelUnified("metadata", makeMeta("fn()"), 5)).toBe(" @@ -10,6 +10,8 @@ fn() ");
	});

	it("metadata style without context", () => {
		expect(sepLabelUnified("metadata", makeMeta(), 5)).toBe(" @@ -10,6 +10,8 @@ ");
	});

	it("metadata style falls back to ellipsis without hunkMeta", () => {
		expect(sepLabelUnified("metadata", undefined, null)).toBe("···");
	});
});

describe("sepLabelSplit", () => {
	const makeMeta = (ctx?: string): HunkMeta => ({ oldStart: 10, oldLines: 6, newStart: 10, newLines: 8, context: ctx });

	it("auto style shows context + gap", () => {
		expect(sepLabelSplit("auto", makeMeta("fn()"), 5)).toBe("··· fn() — +5 lines ···");
	});

	it("context style shows context", () => {
		expect(sepLabelSplit("context", makeMeta("fn()"), 5)).toBe("··· fn() — 5 lines ···");
	});

	it("simple style shows ellipsis", () => {
		expect(sepLabelSplit("simple", makeMeta("fn()"), 5)).toBe("···");
	});

	it("gap style shows gap", () => {
		expect(sepLabelSplit("gap", makeMeta("fn()"), 5)).toBe("··· 5 lines ···");
	});

	it("metadata style shows header with context", () => {
		expect(sepLabelSplit("metadata", makeMeta("fn()"), 5)).toBe("··· @@ -10,6 +10,8 @@ fn() ···");
	});
});

describe("resolveSepStyle", () => {
	beforeEach(() => {
		delete process.env.PI_DIFF_SEP_STYLE;
		resolveSepStyle(); // reset to default
	});

	it("defaults to auto", () => {
		expect(getSepStyle()).toBe("auto");
	});

	it("reads from env var", () => {
		process.env.PI_DIFF_SEP_STYLE = "simple";
		resolveSepStyle();
		expect(getSepStyle()).toBe("simple");
	});

	it("ignores invalid env value", () => {
		process.env.PI_DIFF_SEP_STYLE = "invalid";
		resolveSepStyle();
		expect(getSepStyle()).toBe("auto");
	});
});

// ---------------------------------------------------------------------------
// computeHunkBlocks
// ---------------------------------------------------------------------------

describe("computeHunkBlocks", () => {
	it("extracts paired del/add blocks from a flat ParsedDiff", () => {
		const diff = parseDiff("a\nb\nc\n", "a\nB\nC\nc\n");
		const blocks = computeHunkBlocks(diff);
		expect(blocks.length).toBeGreaterThanOrEqual(1);
		for (const block of blocks) {
			expect(block.deletions.length).toBeGreaterThan(0);
			expect(block.additions.length).toBeGreaterThan(0);
		}
	});

	it("returns empty array for empty diff", () => {
		const diff = parseDiff("", "");
		expect(computeHunkBlocks(diff)).toEqual([]);
	});

	it("preserves deletion and addition contents", () => {
		const diff = parseDiff("old\n", "new\n");
		const blocks = computeHunkBlocks(diff);
		expect(blocks.length).toBe(1);
		expect(blocks[0].deletions[0].content).toBe("old");
		expect(blocks[0].additions[0].content).toBe("new");
	});

	it("handles unbalanced blocks (more adds than dels)", () => {
		const diff = parseDiff("x\n", "x\ny\nz\n");
		const blocks = computeHunkBlocks(diff);
		expect(blocks.length).toBe(1);
		expect(blocks[0].deletions).toHaveLength(0);
		expect(blocks[0].additions.length).toBe(2);
	});

	it("skips sep and ctx lines", () => {
		const diff = parseDiff("a\nb\nc\nd\ne\n", "A\nb\nC\nd\nE\n");
		const blocks = computeHunkBlocks(diff);
		expect(blocks.length).toBeGreaterThanOrEqual(1);
		for (const block of blocks) {
			for (const d of block.deletions) expect(d.type).toBe("del");
			for (const a of block.additions) expect(a.type).toBe("add");
		}
	});
});
