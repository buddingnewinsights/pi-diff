import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../", import.meta.url));
const hostEntry = process.argv[2]
	? pathToFileURL(resolve(process.argv[2])).href
	: import.meta.resolve("@earendil-works/pi-coding-agent");
const { discoverAndLoadExtensions } = await import(hostEntry);
const hostRequire = createRequire(hostEntry);
const hostTui = await import(
	pathToFileURL(process.argv[3] ? resolve(process.argv[3]) : hostRequire.resolve("@earendil-works/pi-tui")).href
);
const Text = hostTui.Text ?? hostTui.VIRTUAL_MODULES["@earendil-works/pi-tui"].Text;
const root = mkdtempSync(join(tmpdir(), "pi-diff-host-loading-"));
const originalCwd = process.cwd();
const theme = { fg: (_name, text) => text, bold: (text) => text };

function npm(args, cwd) {
	return execFileSync("npm", args, {
		cwd,
		encoding: "utf8",
		timeout: 120_000,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function assertNoHostCopies(directory) {
	if (!existsSync(directory)) return;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const child = join(directory, entry.name);
		const manifestPath = join(child, "package.json");
		if (existsSync(manifestPath)) {
			const { name } = JSON.parse(readFileSync(manifestPath, "utf8"));
			assert.ok(!name?.startsWith("@earendil-works/pi-"), `Unexpected SDK copy: ${child}`);
		}
		assertNoHostCopies(child);
	}
}

try {
	const [packed] = Object.values(
		JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", root], repo)),
	);
	for (const layout of ["agent/npm", ".pi/npm"]) {
		const installDir = join(root, layout);
		npm(
			[
				"install",
				"--prefix",
				installDir,
				join(root, packed.filename),
				"--omit=dev",
				"--legacy-peer-deps",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"--prefer-offline",
			],
			repo,
		);
		const packageDir = join(installDir, "node_modules", "@heyhuynhgiabuu", "pi-diff");
		const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
		for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
			assert.equal(manifest.peerDependencies[name], "*");
			assert.equal(manifest.dependencies[name], undefined);
		}
		assertNoHostCopies(join(installDir, "node_modules"));
		const installedRequire = createRequire(join(packageDir, "package.json"));
		for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
			assert.throws(() => installedRequire.resolve(name), {
				code: "MODULE_NOT_FOUND",
			});
		}
		writeFileSync(join(installDir, "pi-diff.json"), JSON.stringify({ disabledTools: [] }));
		process.chdir(installDir);
		const loaded = await discoverAndLoadExtensions([packageDir], installDir, join(root, "empty-agent"));
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		const tools = loaded.extensions[0].tools;
		assert.deepEqual([...tools.keys()].sort(), ["apply_patch", "edit", "write"]);

		const file = join(installDir, "sample.ts");
		const write = tools.get("write").definition;
		const written = await write.execute("write-test", {
			path: file,
			content: "const value = 1;\n",
		});
		assert.equal(written.details._type, "new");
		const call = write.renderCall({ path: file }, theme, {
			state: {},
			toolCallId: "write-test",
		});
		assert.ok(call instanceof Text, "Renderer must use the host Text class");

		const edit = tools.get("edit").definition;
		const edited = await edit.execute("edit-test", {
			path: file,
			edits: [{ oldText: "const value = 1;", newText: "const value = 2;" }],
		});
		assert.equal(edited.details._type, "editInfo");
		assert.equal(readFileSync(file, "utf8"), "const value = 2;\n");

		const patch = tools.get("apply_patch").definition;
		const patched = await patch.execute(
			"patch-test",
			{
				changes: [
					{
						action: "update",
						path: file,
						oldText: "const value = 2;",
						newText: "const value = 3;",
					},
				],
			},
			undefined,
			undefined,
			{ cwd: installDir },
		);
		assert.notEqual(patched.isError, true);
		assert.equal(readFileSync(file, "utf8"), "const value = 3;\n");
		console.log(`${layout}: no SDK copies; host Text identity; write/edit/apply_patch passed`);
	}
} finally {
	process.chdir(originalCwd);
	rmSync(root, { recursive: true, force: true });
}
