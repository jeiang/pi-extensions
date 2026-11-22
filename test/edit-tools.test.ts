import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EditStore } from "@oh-my-pi/pi-natives";
import workspace from "../extensions/workspace/index.ts";
import { parseGrep, structuredGrep } from "../extensions/workspace/grep.ts";
import { substituteTool } from "../extensions/workspace/substitute.ts";
import { createTestSession, type Reply, scriptedProviders } from "./harness.ts";

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "edit-tools-")));

async function run(dir: string, replies: (results: string[]) => Reply | undefined) {
	const results: string[] = [];
	const { session } = await createTestSession({
		extensions: [
			scriptedProviders((_m, context) => {
				const last = context.messages.at(-1);
				if (last?.role === "toolResult") results.push(last.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"));
				return replies(results) ?? { text: "done" };
			}, []),
			workspace,
		],
		model: ["p1", "m"],
		cwd: dir,
	});
	await session.prompt("go");
	session.dispose();
	return results;
}

test("replace refuses text that occurs twice or differs only in whitespace, and applies an exact unique match", async () => {
	const dir = temp();
	const file = join(dir, "f.txt");
	writeFileSync(file, "a  = 1;\nb = 2;\nb = 2;\n");
	const results = await run(dir, (r): Reply | undefined => {
		if (r.length === 0) return { tool: "read", args: { path: "f.txt" } };
		if (r.length === 1) return { tool: "replace", args: { path: "f.txt", old_string: "b = 2;", new_string: "B" } };
		if (r.length === 2) return { tool: "replace", args: { path: "f.txt", old_string: "a = 1;", new_string: "A" } };
		if (r.length === 3) return { tool: "replace", args: { path: "f.txt", old_string: "a  = 1;", new_string: "A" } };
		return undefined;
	});
	assert.match(results[1] ?? "", /2 occurrences/);
	assert.match(results[2] ?? "", /exact text/);
	assert.equal(readFileSync(file, "utf8"), "A\nb = 2;\nb = 2;\n");
});

test("substitute previews without writing, refuses a stale token, and searches gitignored files only when named", async () => {
	const dir = temp();
	execFileSync("git", ["init", "-q"], { cwd: dir });
	writeFileSync(join(dir, ".gitignore"), "build/\n");
	mkdirSync(join(dir, "build"));
	writeFileSync(join(dir, "a.ts"), "foo(1); foo(2);\n");
	writeFileSync(join(dir, "b.ts"), "bar\n");
	writeFileSync(join(dir, "build", "gen.ts"), "foo(3);\n");
	const tool = substituteTool(new EditStore())(dir);
	const call = async (input: Record<string, unknown>) => {
		const result = await tool.execute("id", { pattern: "foo\\((\\d)\\)", replacement: "baz($1)", ...input } as never, undefined, undefined, undefined as never);
		return result.structuredContent as { applied: boolean; token: string; total: number; files: { path: string; count: number }[] };
	};

	const preview = await call({ glob: "*.ts" });
	assert.equal(preview.applied, false);
	assert.deepEqual(
		preview.files.map((f) => [f.path, f.count]),
		[["a.ts", 2]],
	);
	assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), "foo(1); foo(2);\n");

	const named = await call({ paths: ["a.ts", "build/gen.ts"] });
	assert.equal(named.total, 3);

	writeFileSync(join(dir, "b.ts"), "bar changed\n");
	await assert.rejects(call({ glob: "*.ts", apply: true, token: preview.token }), /token/);
	assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), "foo(1); foo(2);\n");

	const fresh = await call({ glob: "*.ts" });
	const applied = await call({ glob: "*.ts", apply: true, token: fresh.token });
	assert.equal(applied.applied, true);
	assert.equal(readFileSync(join(dir, "a.ts"), "utf8"), "baz(1); baz(2);\n");
	assert.equal(readFileSync(join(dir, "build", "gen.ts"), "utf8"), "foo(3);\n");
});

test("grep's structured result follows pi's grep output", async () => {
	const dir = temp();
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src", "a.ts"), "one\nneedle here\nthree: 4: x\n");
	const tool = structuredGrep(dir);
	const result = await tool.execute("id", { pattern: "needle", path: "src", context: 1 }, undefined, undefined, { cwd: dir } as never);
	assert.deepEqual((result as { structuredContent?: unknown }).structuredContent, {
		lines: [
			{ path: "src/a.ts", line: 1, text: "one", match: false },
			{ path: "src/a.ts", line: 2, text: "needle here", match: true },
			{ path: "src/a.ts", line: 3, text: "three: 4: x", match: false },
		],
		files: ["src/a.ts"],
	});
	assert.deepEqual(parseGrep("No matches found"), { lines: [], files: [] });
});
