import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import lsp from "../extensions/lsp/index.ts";
import { type FileReport, newFindings } from "../extensions/lsp/diagnostics.ts";
import { applyPreview, planWorkspaceEdit, storePreview } from "../extensions/lsp/edits.ts";
import { stopInstances } from "../extensions/lsp/pool.ts";
import workspace from "../extensions/workspace/index.ts";
import { createTestSession, type Reply, scriptedProviders } from "./harness.ts";

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "lsp-")));
const uri = (path: string) => pathToFileURL(path).href;
const at = (line: number, character: number) => ({ line, character });

const report = (text: string, rows: [number, string][]): FileReport => ({
	path: "/f",
	text,
	outcomes: [{ server: "s", status: "fresh" }],
	findings: rows.map(([line, message]) => ({ source: "s", encoding: "utf-16", diagnostic: { range: { start: at(line, 0), end: at(line, 1) }, severity: 1, message } })),
});

test("baseline matching follows a finding to its new line and counts duplicates", () => {
	const before = report("bad()\nok\nbad()\n", [
		[0, "boom"],
		[2, "boom"],
	]);
	const after = report("added\nbad()\nok\nbad()\nbad()\n", [
		[1, "boom"],
		[3, "boom"],
		[4, "boom"],
	]);
	const { added, unchanged } = newFindings(before, after);
	assert.equal(unchanged, 2);
	assert.deepEqual(
		added.map((f) => f.diagnostic.range.start.line),
		[4],
	);
	assert.equal(newFindings(undefined, after).added.length, 3);
});

test("a workspace edit applies with BOM and mode kept, and moves a file with its edits", async () => {
	const dir = temp();
	const a = join(dir, "a.txt");
	const b = join(dir, "b.txt");
	writeFileSync(a, "\ufefflet old = 1;\nuse(old);\n");
	chmodSync(a, 0o755);
	writeFileSync(b, "old\n");
	const changes = await planWorkspaceEdit(
		{
			documentChanges: [
				{ textDocument: { uri: uri(a), version: null }, edits: [{ range: { start: at(0, 4), end: at(0, 7) }, newText: "fresh" }, { range: { start: at(1, 4), end: at(1, 7) }, newText: "fresh" }] },
				{ kind: "rename", oldUri: uri(b), newUri: uri(join(dir, "sub", "c.txt")) },
			],
		},
		"utf-16",
	);
	await applyPreview(storePreview("test", changes).token);
	assert.equal(readFileSync(a, "utf8"), "\ufefflet fresh = 1;\nuse(fresh);\n");
	assert.equal(statSync(a).mode & 0o777, 0o755);
	assert.equal(readFileSync(join(dir, "sub", "c.txt"), "utf8"), "old\n");
	assert.throws(() => statSync(b));
});

test("apply refuses a file changed since the preview and writes nothing", async () => {
	const dir = temp();
	const a = join(dir, "a.txt");
	const b = join(dir, "b.txt");
	writeFileSync(a, "x\n");
	writeFileSync(b, "x\n");
	const edit = { range: { start: at(0, 0), end: at(0, 1) }, newText: "y" };
	const preview = storePreview("test", await planWorkspaceEdit({ changes: { [uri(a)]: [edit], [uri(b)]: [edit] } }, "utf-16"));
	writeFileSync(b, "changed\n");
	await assert.rejects(applyPreview(preview.token), /changed since the preview/);
	assert.equal(readFileSync(a, "utf8"), "x\n");
});

test("a write that fails part way puts back the files already written", async () => {
	const dir = temp();
	const a = join(dir, "a.txt");
	const locked = join(dir, "locked");
	mkdirSync(locked);
	const b = join(locked, "b.txt");
	writeFileSync(a, "x\n");
	writeFileSync(b, "x\n");
	const edit = { range: { start: at(0, 0), end: at(0, 1) }, newText: "y" };
	const preview = storePreview("test", await planWorkspaceEdit({ changes: { [uri(a)]: [edit], [uri(b)]: [edit] } }, "utf-16"));
	chmodSync(locked, 0o555);
	try {
		await assert.rejects(applyPreview(preview.token), /rolled back/);
	} finally {
		chmodSync(locked, 0o755);
	}
	assert.equal(readFileSync(a, "utf8"), "x\n");
	assert.equal(readFileSync(b, "utf8"), "x\n");
});

test("a move that fails part way restores the file it overwrote, and a recreated file is not deleted", async () => {
	const dir = temp();
	const locked = join(dir, "locked");
	mkdirSync(locked);
	const source = join(locked, "s.txt");
	const target = join(dir, "t.txt");
	writeFileSync(source, "source\n");
	chmodSync(source, 0o444);
	writeFileSync(target, "target\n");
	const preview = storePreview("test", await planWorkspaceEdit({ documentChanges: [{ kind: "rename", oldUri: uri(source), newUri: uri(target), options: { overwrite: true } }] }, "utf-16"));
	chmodSync(locked, 0o555);
	try {
		await assert.rejects(applyPreview(preview.token), /rolled back/);
	} finally {
		chmodSync(locked, 0o755);
	}
	assert.equal(readFileSync(target, "utf8"), "target\n");
	assert.equal(readFileSync(source, "utf8"), "source\n");

	const file = join(dir, "r.txt");
	writeFileSync(file, "old\n");
	const changes = await planWorkspaceEdit(
		{
			documentChanges: [
				{ kind: "delete", uri: uri(file) },
				{ kind: "create", uri: uri(file) },
				{ textDocument: { uri: uri(file), version: null }, edits: [{ range: { start: at(0, 0), end: at(0, 0) }, newText: "new\n" }] },
			],
		},
		"utf-16",
	);
	await applyPreview(storePreview("test", changes).token);
	assert.equal(readFileSync(file, "utf8"), "new\n");
});

test("an edit's result lists only the findings it introduced; rename previews, then applies with the token", async () => {
	const dir = temp();
	const agentDir = temp();
	const server = { command: process.execPath, args: [join(import.meta.dirname, "fixtures", "fake-lsp.ts")], languages: [{ languageId: "fake", extensions: [".fake"] }] };
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ lsp: { servers: { fake: server } } }));
	writeFileSync(join(dir, "f.fake"), "function greet() {\nERROR one\n}\n");
	writeFileSync(join(dir, "g.fake"), "greet\n");
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const results: string[] = [];
	let token = "";
	try {
		const { session } = await createTestSession({
			extensions: [
				scriptedProviders((_m, context): Reply => {
					const last = context.messages.at(-1);
					if (last?.role === "toolResult") results.push(last.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"));
					token = /token "(\w+)"/.exec(results.at(-1) ?? "")?.[1] ?? token;
					if (results.length === 0) return { tool: "write", args: { path: "f.fake", content: "// top\nfunction greet() {\nERROR one\nERROR two\n}\n" } };
					if (results.length === 1) return { tool: "lsp", args: { op: "diagnostics", path: "g.fake" } };
					if (results.length === 2) return { tool: "lsp", args: { op: "rename", path: "f.fake", symbol: "greet", new_name: "hello" } };
					if (results.length === 3) return { tool: "lsp", args: { op: "rename", apply: true, token } };
					return { text: "done" };
				}, []),
				workspace,
				lsp,
			],
			model: ["p1", "m"],
			cwd: dir,
		});
		await session.prompt("go");
		session.dispose();
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await stopInstances("fake");
	}
	assert.match(results[0] ?? "", /LSP: 1 new finding\(s\); 1 unchanged:\nf\.fake:4:1 error fake: ERROR found/);
	assert.match(results[2] ?? "", /Preview of rename to hello: 2 file\(s\)/);
	assert.match(results[3] ?? "", /Applied rename to hello/);
	assert.equal(readFileSync(join(dir, "f.fake"), "utf8"), "// top\nfunction hello() {\nERROR one\nERROR two\n}\n");
	assert.equal(readFileSync(join(dir, "g.fake"), "utf8"), "hello\n");
});
