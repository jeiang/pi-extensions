import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import workspace from "../extensions/workspace/index.ts";
import { grepRoute } from "../extensions/workspace/shell.ts";
import { type Call, createTestSession, type Reply, scriptedProviders } from "./harness.ts";

function repo(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ws-repo-")));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("config", "commit.gpgsign", "false");
	writeFileSync(join(dir, "README"), "hi\n");
	git("add", "README");
	git("commit", "-q", "-m", "init");
	return dir;
}

async function session(cwd: string, replies: Reply[]) {
	const calls: Call[] = [];
	const { session } = await createTestSession({
		extensions: [scriptedProviders((_m, _c, i) => replies[i] ?? { text: "done" }, calls), workspace],
		model: ["p1", "m"],
		cwd,
	});
	return { session, calls };
}

const toolResults = (s: Awaited<ReturnType<typeof session>>["session"]) =>
	s.messages.flatMap((m) => (m.role === "toolResult" ? [m.content.map((c) => (c.type === "text" ? c.text : "")).join("")] : []));

test("the first write creates a worktree and leaves the main checkout untouched", async () => {
	const dir = repo();
	const { session: s } = await session(dir, [
		{ tool: "write", args: { path: "a.txt", content: "new\n" } },
		{ tool: "write", args: { path: join(dir, "b.txt"), content: "abs\n" } },
	]);
	await s.prompt("Add the a file");
	s.dispose();
	const worktree = join(dir, ".worktrees", "add-the-a-file");
	assert.equal(readFileSync(join(worktree, "a.txt"), "utf8"), "new\n");
	assert.equal(readFileSync(join(worktree, "b.txt"), "utf8"), "abs\n");
	assert.equal(existsSync(join(dir, "a.txt")), false);
	assert.equal(existsSync(join(dir, "b.txt")), false);
	assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }), "");
	assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: worktree, encoding: "utf8" }).trim(), "add-the-a-file");
});

test("git mutations in the main checkout are blocked until a worktree exists", async () => {
	const dir = repo();
	const { session: s } = await session(dir, [
		{ tool: "bash", args: { command: "touch x && git add x && git commit -qm x" } },
	]);
	await s.prompt("commit");
	s.dispose();
	assert.match(toolResults(s)[0] ?? "", /worktree tool first/);
	assert.equal(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: dir, encoding: "utf8" }).trim(), "1");
});

test("a background job returns at the first matching line and keeps running", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ws-shell-"));
	const { session: s } = await session(dir, [
		{ tool: "shell", args: { command: "echo starting; echo READY; sleep 5; echo late", background: true, wait_on: "READY" } },
		{ tool: "shell", args: { action: "kill", job: "job1" } },
	]);
	const started = Date.now();
	await s.prompt("serve");
	s.dispose();
	const [first, second] = toolResults(s);
	assert.match(first ?? "", /Matched; still running/);
	assert.match(first ?? "", /READY/);
	assert.match(second ?? "", /killed/);
	assert.ok(Date.now() - started < 4000);
});

test("grepRoute serves plain rg and grep calls only", () => {
	assert.deepEqual(grepRoute("rg -i 'foo bar' src"), { ignoreCase: true, pattern: "foo bar", path: "src" });
	assert.deepEqual(grepRoute("grep -rn TODO ."), { pattern: "TODO", path: "." });
	assert.equal(grepRoute("rg foo | head"), undefined);
	assert.equal(grepRoute("grep foo"), undefined);
	assert.equal(grepRoute("rg --json foo"), undefined);
	assert.equal(grepRoute("rg $PAT"), undefined);
});
