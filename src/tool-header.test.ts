import { strict as assert } from "node:assert";
import { Box, Spacer, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, it, vi } from "vitest";
import diffRendererExtension, { __testing } from "./index.js";

vi.mock("./core/config.js", () => ({
	configIndicatorStyle: () => undefined,
	loadPiDiffConfig: () => ({}),
}));

describe("tool header names", () => {
	it("prefixes write, edit, and apply_patch with a left arrow", () => {
		assert.equal(__testing.formatToolHeaderName("write"), "← write");
		assert.equal(__testing.formatToolHeaderName("create"), "← create");
		assert.equal(__testing.formatToolHeaderName("edit"), "← edit");
		assert.equal(__testing.formatToolHeaderName("apply_patch"), "← apply_patch");
		assert.equal(__testing.formatToolHeaderName("read"), "read");
	});

	it("uses toolTitle for tool header paths", () => {
		const theme = { fg: (name: string, text: string) => `${name}:${text}` };
		assert.equal(__testing.formatToolHeaderPath(theme, "src/index.ts"), "toolTitle:src/index.ts");
	});

	it("uses the tool result error flag when rendering failures", () => {
		const testing = __testing as typeof __testing & {
			isToolResultError(result: { isError?: boolean }, context: { isError?: boolean }): boolean;
		};
		assert.equal(testing.isToolResultError({ isError: true }, { isError: false }), true);
		assert.equal(testing.isToolResultError({ isError: false }, { isError: true }), true);
		assert.equal(testing.isToolResultError({ isError: false }, { isError: false }), false);
	});
});

type Renderable = { render(width: number): string[] };

const renderTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
	bg: (_name: string, text: string) => text,
	getFgAnsi: () => "\x1b[38;2;100;180;120m",
	getBgAnsi: () => "\x1b[48;2;10;10;10m",
};

async function getRenderedTools(): Promise<Map<string, any>> {
	const tools = new Map<string, any>();
	await diffRendererExtension({
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
	} as any);
	return tools;
}

const SHELL_WIDTH = 80;

// Mirrors the host's default shell: a Spacer, then a Box whose paddingX is the outputPad setting (0 or 1 in Pi).
function renderToolShell(outputPad: number, ...components: Renderable[]): string[] {
	const box = new Box(outputPad, 1);
	for (const component of components) box.addChild(component as any);
	return [...new Spacer(1).render(SHELL_WIDTH), ...box.render(SHELL_WIDTH)].map(stripTerminalSequences);
}

function renderDefaultToolShell(...components: Renderable[]): string[] {
	return renderToolShell(1, ...components);
}

function leadingSpaces(line: string): number {
	return line.match(/^ */)?.[0].length ?? 0;
}

function lineContaining(lines: string[], text: string): { line: string; index: number } {
	const index = lines.findIndex((line) => line.includes(text));
	assert.notEqual(index, -1, `expected a line containing ${JSON.stringify(text)}`);
	return { line: lines[index], index };
}

describe("write/edit/apply_patch shell spacing", () => {
	it("keeps one host-provided space and one top shell pad on both titles", async () => {
		const tools = await getRenderedTools();
		const cases = [
			{
				name: "write",
				args: { path: "package.json", content: "next" },
			},
			{
				name: "edit",
				args: { path: "package.json", edits: [{ oldText: "old", newText: "new" }] },
			},
		];

		for (const { name, args } of cases) {
			assert.equal(tools.get(name).renderShell, "default");
			const call = tools.get(name).renderCall(args, renderTheme, {
				argsComplete: true,
				lastComponent: undefined,
				state: {},
				toolCallId: `${name}-call`,
			});
			const lines = renderDefaultToolShell(call);
			const title = lineContaining(lines, `← ${name}`);
			assert.equal(title.index, 2, `${name} title should follow the host spacer and top pad`);
			assert.equal(leadingSpaces(title.line), 1, `${name} title should have one leading space`);
		}
	});

	it("does not pre-pad create headers to the terminal width", async () => {
		const tools = await getRenderedTools();
		const path = `/tmp/pi-diff-layout-missing-${process.pid}`;
		const call = tools.get("write").renderCall({ path, content: "const value = 1;" }, renderTheme, {
			argsComplete: true,
			lastComponent: undefined,
			state: {},
			toolCallId: "create-call",
			invalidate() {},
		});
		const lines = renderDefaultToolShell(call);
		const title = lineContaining(lines, "← create");
		assert.equal(title.index, 2);
		assert.equal(lines.length, 4);
	});

	it("keeps one leading space on diff bodies and one trailing shell pad", async () => {
		const tools = await getRenderedTools();
		const diff = __testing.parseDiff("old();\n", "new();\n");

		for (const name of ["write", "edit"]) {
			const args =
				name === "write"
					? { path: "package.json", content: "next" }
					: { path: "package.json", edits: [{ oldText: "old", newText: "new" }] };
			const call = tools.get(name).renderCall(args, renderTheme, {
				argsComplete: true,
				lastComponent: undefined,
				state: {},
				toolCallId: `${name}-body-call`,
			});
			const result = tools.get(name).renderResult(
				{
					content: [{ type: "text", text: "ok" }],
					details: { _type: name === "write" ? "diff" : "editInfo", diff, language: undefined },
				},
				{ expanded: true, isPartial: false },
				renderTheme,
				{ args, state: {}, lastComponent: undefined, invalidate() {}, isError: false },
			);
			const lines = renderDefaultToolShell(call, result);
			const body = lineContaining(lines, "rendering diff");
			assert.equal(leadingSpaces(body.line), 1, `${name} diff body should have one leading space`);
			assert.equal(
				body.index,
				lineContaining(lines, `← ${name}`).index + 1,
				`${name} diff should sit directly under the title`,
			);
			let trailingBlankLines = 0;
			for (let index = lines.length - 1; index >= 0 && lines[index].trim() === ""; index--) trailingBlankLines++;
			assert.equal(trailingBlankLines, 1, `${name} diff should have one trailing shell pad`);
		}
	});

	it("keeps one leading space on non-diff result lines and error messages", async () => {
		const tools = await getRenderedTools();
		const cases = [
			{
				name: "write",
				args: { path: "package.json", content: "next" },
				result: { content: [{ type: "text", text: "✓ no changes" }], details: { _type: "noChange" } },
				needle: "✓ no changes",
			},
			{
				name: "edit",
				args: { path: "package.json", edits: [{ oldText: "old", newText: "new" }] },
				result: { content: [{ type: "text", text: "done" }], details: undefined },
				needle: "done",
			},
		];

		for (const { name, args, result, needle } of cases) {
			const body = tools.get(name).renderResult(result, { expanded: true, isPartial: false }, renderTheme, {
				args,
				state: {},
				lastComponent: undefined,
				invalidate() {},
				isError: false,
			});
			const lines = renderDefaultToolShell(body);
			const line = lineContaining(lines, needle);
			assert.equal(leadingSpaces(line.line), 1, `${name} result should have one leading space`);
		}

		for (const name of ["write", "edit"]) {
			const args =
				name === "write"
					? { path: "package.json", content: "next" }
					: { path: "package.json", edits: [{ oldText: "old", newText: "new" }] };
			const error = tools
				.get(name)
				.renderResult(
					{ content: [{ type: "text", text: "failure" }], isError: true },
					{ expanded: true, isPartial: false },
					renderTheme,
					{ args, state: {}, lastComponent: undefined, invalidate() {}, isError: true },
				);
			const lines = renderDefaultToolShell(error);
			assert.equal(leadingSpaces(lineContaining(lines, `← ${name}`).line), 1, `${name} error title should be aligned`);
			assert.equal(leadingSpaces(lineContaining(lines, "failure").line), 1, `${name} error should be aligned`);
		}
	});

	it("applies the same minimal shell spacing to apply_patch", async () => {
		const tools = await getRenderedTools();
		const tool = tools.get("apply_patch");
		assert.equal(tool.renderShell, "default");
		const change = { path: "package.json", action: "update", oldText: "old", newText: "new" };

		const call = tool.renderCall({ changes: [change] }, renderTheme, {
			argsComplete: false,
			lastComponent: undefined,
			state: {},
			toolCallId: "apply-call",
		});
		const callTitle = lineContaining(renderDefaultToolShell(call), "← apply_patch");
		assert.equal(callTitle.index, 2);
		assert.equal(leadingSpaces(callTitle.line), 1);

		const result = tool.renderResult(
			{
				content: [{ type: "text", text: "ok" }],
				details: {
					_type: "applyPatchInfo",
					result: {
						ok: true,
						applied: [{ action: "update", path: "package.json", oldContent: "old();\n", newContent: "new();\n" }],
						errors: [],
					},
				},
			},
			{ expanded: true, isPartial: false },
			renderTheme,
			{ args: { changes: [change] }, state: {}, lastComponent: undefined, invalidate() {}, isError: false },
		);
		const resultLines = renderDefaultToolShell(result);
		assert.equal(leadingSpaces(lineContaining(resultLines, "rendering diff").line), 1);
		let trailingBlankLines = 0;
		for (let index = resultLines.length - 1; index >= 0 && resultLines[index].trim() === ""; index--)
			trailingBlankLines++;
		assert.equal(trailingBlankLines, 1);

		const error = tool.renderResult(
			{ content: [{ type: "text", text: "failure" }], isError: true },
			{ expanded: true, isPartial: false },
			renderTheme,
			{ args: { changes: [change] }, state: {}, lastComponent: undefined, invalidate() {}, isError: true },
		);
		const errorLines = renderDefaultToolShell(error);
		assert.equal(leadingSpaces(lineContaining(errorLines, "← apply_patch").line), 1);
		assert.equal(leadingSpaces(lineContaining(errorLines, "failure").line), 1);
	});
});

// Diff previews render asynchronously: the first pass shows a placeholder and the real diff lands on a later render.
async function settleShell(render: () => string[], settled: Promise<void>): Promise<string[]> {
	render();
	await settled;
	const lines = render();
	assert.equal(
		lines.some((line) => line.includes("rendering diff")),
		false,
		"diff preview should settle",
	);
	return lines;
}

function renderDiffTool(
	tools: Map<string, any>,
	name: string,
	diff: ReturnType<typeof __testing.parseDiff>,
	id: string,
): { call: Renderable; result: Renderable; settled: Promise<void> } {
	let invalidate = () => {};
	const settled = new Promise<void>((resolve) => {
		invalidate = resolve;
	});
	const args =
		name === "write"
			? { path: "package.json", content: "next" }
			: { path: "package.json", edits: [{ oldText: "old", newText: "new" }] };
	const tool = tools.get(name);
	const call = tool.renderCall(args, renderTheme, {
		argsComplete: true,
		lastComponent: undefined,
		state: {},
		toolCallId: `${id}-call`,
	});
	const result = tool.renderResult(
		{
			content: [{ type: "text", text: "ok" }],
			details: { _type: name === "write" ? "diff" : "editInfo", diff, language: undefined },
		},
		{ expanded: true, isPartial: false },
		renderTheme,
		{ args, state: {}, lastComponent: undefined, invalidate, isError: false },
	);
	return { call, result, settled };
}

describe.each([0, 1, 2])("tool shell with outputPad %i", (outputPad) => {
	it("pads each title exactly once with outputPad", async () => {
		const tools = await getRenderedTools();
		// apply_patch hides its own title once args are complete (the result header takes over), so check it while streaming.
		const cases = [
			{ name: "write", args: { path: "package.json", content: "next" }, argsComplete: true },
			{ name: "edit", args: { path: "package.json", edits: [{ oldText: "old", newText: "new" }] }, argsComplete: true },
			{
				name: "apply_patch",
				args: { changes: [{ path: "package.json", action: "update", oldText: "old", newText: "new" }] },
				argsComplete: false,
			},
		];
		for (const { name, args, argsComplete } of cases) {
			const call = tools.get(name).renderCall(args, renderTheme, {
				argsComplete,
				lastComponent: undefined,
				state: {},
				toolCallId: `${name}-title-pad-${outputPad}`,
			});
			const lines = renderToolShell(outputPad, call);
			const title = lineContaining(lines, `← ${name}`);
			assert.equal(title.index, 2, `${name} title should follow the host spacer and top pad`);
			assert.equal(leadingSpaces(title.line), outputPad, `${name} title should have exactly outputPad leading spaces`);
		}
	});

	it("pads diff bodies by exactly outputPad on top of the diff's own gutter", async () => {
		const tools = await getRenderedTools();
		const diff = __testing.parseDiff("old();\n", "new();\n");
		for (const name of ["write", "edit"]) {
			const { call, result, settled } = renderDiffTool(tools, name, diff, `${name}-body-pad-${outputPad}`);
			// The first render is the placeholder, which carries only the body pad (no diff gutter), so it isolates that pad.
			const placeholder = lineContaining(renderToolShell(outputPad, call, result), "rendering diff");
			assert.equal(
				leadingSpaces(placeholder.line),
				outputPad,
				`${name} placeholder body should have exactly outputPad leading spaces`,
			);
			const lines = await settleShell(() => renderToolShell(outputPad, call, result), settled);
			const componentLines = result.render(SHELL_WIDTH - outputPad * 2).map(stripTerminalSequences);
			assert.ok(
				componentLines.some((line) => line.includes("new();")),
				`${name} body should be the rendered diff, not a placeholder`,
			);

			const titleIndex = lineContaining(lines, `← ${name}`).index;
			const body = lines.slice(titleIndex + 1, titleIndex + 1 + componentLines.length);
			assert.equal(body.length, componentLines.length, `${name} body should sit directly under the title`);
			componentLines.forEach((componentLine, row) => {
				assert.equal(
					body[row].slice(0, outputPad),
					" ".repeat(outputPad),
					`${name} body row ${row} should start with exactly outputPad spaces`,
				);
				assert.equal(
					body[row].slice(outputPad).trimEnd(),
					componentLine.trimEnd(),
					`${name} body row ${row} should add no padding beyond outputPad`,
				);
			});

			const trailing = lines.slice(titleIndex + 1 + componentLines.length);
			assert.deepEqual(
				trailing.map((line) => line.trim()),
				[""],
				`${name} diff should have one trailing shell pad`,
			);
		}
	});

	it("keeps shell lines inside the render width and truncates long diff rows to the inset width", async () => {
		const tools = await getRenderedTools();
		const long = `const value = "${"x".repeat(150)}";`;
		const diff = __testing.parseDiff(`old();\n${long}\n`, `new();\n${long.replace("x", "y")}\n`);
		for (const name of ["write", "edit"]) {
			const { call, result, settled } = renderDiffTool(tools, name, diff, `${name}-width-pad-${outputPad}`);
			const lines = await settleShell(() => renderToolShell(outputPad, call, result), settled);
			// Two removed and two added lines, one unified row each; a wrapped row would add shell rows beyond four.
			const titleIndex = lineContaining(lines, `← ${name}`).index;
			const bodyRows = lines.slice(titleIndex + 1, lines.length - 1); // the last line is the Box's bottom pad
			assert.equal(bodyRows.length, 4, `${name} long diff rows should be truncated to one shell row each, not wrapped`);
			for (const line of lines) {
				assert.ok(
					visibleWidth(line) <= SHELL_WIDTH,
					`${name} line should not exceed ${SHELL_WIDTH} columns: ${JSON.stringify(line)}`,
				);
				assert.ok(
					visibleWidth(line.trimEnd()) <= SHELL_WIDTH - outputPad,
					`${name} line should keep a ${outputPad}-column right pad: ${JSON.stringify(line)}`,
				);
			}
			const truncated = lineContaining(lines, "›");
			assert.equal(
				visibleWidth(truncated.line.trimEnd()),
				SHELL_WIDTH - outputPad,
				`${name} long diff row should fill exactly the inset width`,
			);
		}
	});
});
