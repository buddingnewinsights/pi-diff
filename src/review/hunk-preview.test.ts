import { describe, expect, it, vi } from "vitest";

vi.mock("@shikijs/cli", () => ({
	codeToANSI: vi.fn(async (code: string) => code),
}));

import { renderReviewHunkPreview } from "./hunk-preview.js";

describe("renderReviewHunkPreview", () => {
	it("renders a focused hunk with real diff line numbers and changed content", async () => {
		const preview = await renderReviewHunkPreview({
			filePath: "src/example.ts",
			width: 72,
			hunk: {
				id: "src/example.ts:10:10",
				oldStart: 10,
				oldLines: 2,
				newStart: 10,
				newLines: 3,
				header: "@@ -10,2 +10,3 @@",
				lines: [
					{ type: "ctx", oldNum: 10, newNum: 10, content: "const value = 1;" },
					{ type: "del", oldNum: 11, newNum: null, content: "return value;" },
					{ type: "add", oldNum: null, newNum: 11, content: "const next = value + 1;" },
					{ type: "add", oldNum: null, newNum: 12, content: "return next;" },
				],
			},
		});

		expect(preview).toContain("const next = value + 1;");
		expect(preview).toContain("return next;");
		expect(preview).toContain("11");
		expect(preview).toContain("12");
		expect(preview.split("\n").length).toBeGreaterThan(3);
	});

	it("handles asymmetric word-diff ranges gracefully (ref(L) → ref))", async () => {
		// When diffWords treats trailing ')' as "common" and leaves the new side
		// with no ranges, the renderer should fall back to syntax-highlighted diff
		// instead of applying one-sided word-level highlights.
		const preview = await renderReviewHunkPreview({
			filePath: "src/example.ts",
			width: 72,
			hunk: {
				id: "src/example.ts:5:5",
				oldStart: 5,
				oldLines: 1,
				newStart: 5,
				newLines: 1,
				header: "@@ -5,1 +5,1 @@",
				lines: [
					{ type: "del", oldNum: 5, newNum: null, content: "ref(L)" },
					{ type: "add", oldNum: null, newNum: 5, content: "ref)" },
				],
			},
		});

		// Both lines should be present
		expect(preview).toContain("ref(L)");
		expect(preview).toContain("ref)");
		// Should render both as separate diff lines (no crash, no missing content)
		const lines = preview.split("\n");
		const contentLines = lines.filter((l) => l.includes("ref"));
		expect(contentLines.length).toBe(2);
	});
});
