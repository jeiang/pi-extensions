import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import workspace from "../extensions/workspace/index.ts";
import { createTestSession, type Reply, scriptedProviders } from "./harness.ts";

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

const tagOf = (readResult: string) => /^\[[^\]#]+#([0-9A-F]{4})\]/.exec(readResult)?.[1];

test("a whole-file re-read of an unchanged file answers with a digest", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "hashline-")));
	writeFileSync(join(dir, "f.txt"), "one\ntwo\n");
	const results = await run(dir, (r): Reply | undefined => {
		if (r.length === 0) return { tool: "read", args: { path: "f.txt" } };
		if (r.length === 1) return { tool: "read", args: { path: "f.txt" } };
		if (r.length === 2) return { tool: "read", args: { path: "f.txt", offset: 2 } };
		return undefined;
	});
	assert.match(results[0] ?? "", /1:one/);
	assert.match(results[1] ?? "", /unchanged since this session's last full read \(2 lines\)/);
	assert.match(results[2] ?? "", /2:two/);
});

test("read tags a file and edit applies a patch anchored on that tag", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "hashline-")));
	writeFileSync(join(dir, "f.txt"), "one\ntwo\nthree\n");
	const results = await run(dir, (r): Reply | undefined => {
		if (r.length === 0) return { tool: "read", args: { path: "f.txt" } };
		if (r.length === 1) return { tool: "edit", args: { input: `[f.txt#${tagOf(r[0] ?? "")}]\nPUT 2.=2:\n+TWO\n` } };
		return undefined;
	});
	assert.match(results[0] ?? "", /^\[f\.txt#[0-9A-F]{4}\]\n1:one\n2:two\n3:three/);
	assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "one\nTWO\nthree\n");
});

test("edit rejects a tag the file no longer matches", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "hashline-")));
	writeFileSync(join(dir, "f.txt"), "one\ntwo\n");
	const results = await run(dir, (r): Reply | undefined => {
		if (r.length === 0) return { tool: "read", args: { path: "f.txt" } };
		if (r.length === 1) {
			writeFileSync(join(dir, "f.txt"), "changed\nunder\nyou\n");
			return { tool: "edit", args: { input: `[f.txt#${tagOf(r[0] ?? "")}]\nPUT 1.=1:\n+ONE\n` } };
		}
		return undefined;
	});
	assert.equal(readFileSync(join(dir, "f.txt"), "utf8"), "changed\nunder\nyou\n");
	assert.match(results[1] ?? "", /stale|changed|re-read|tag/i);
});
