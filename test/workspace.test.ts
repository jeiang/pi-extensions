import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import workspace from "../extensions/workspace/index.ts";
import { grepRoute } from "../extensions/workspace/shell.ts";
import { carryChanges, createWorktree, pruneWorktrees, remapPath, removeWorktree } from "../extensions/workspace/worktree.ts";
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

test("writes to the main checkout are blocked until a worktree exists, then land in it", async () => {
	const dir = repo();
	const { session: s } = await session(dir, [
		{ tool: "write", args: { path: "a.txt", content: "early\n" } },
		{ tool: "worktree", args: { action: "create", name: "add-a" } },
		{ tool: "write", args: { path: "a.txt", content: "new\n" } },
		{ tool: "write", args: { path: join(dir, "b.txt"), content: "abs\n" } },
	]);
	await s.prompt("Add the a file");
	s.dispose();
	const worktree = join(dir, ".worktrees", "add-a");
	assert.match(toolResults(s)[0] ?? "", /worktree tool first/);
	assert.equal(readFileSync(join(worktree, "a.txt"), "utf8"), "new\n");
	assert.equal(readFileSync(join(worktree, "b.txt"), "utf8"), "abs\n");
	assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }), "");
	assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: worktree, encoding: "utf8" }).trim(), "add-a");
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

test("carry moves edited and new files out of the main checkout into the worktree", async () => {
	const dir = repo();
	const wt = await createWorktree(dir, "carry");
	writeFileSync(join(dir, "README"), "edited\n");
	writeFileSync(join(dir, "new.txt"), "new\n");
	writeFileSync(join(dir, "other.txt"), "stays\n");
	await carryChanges(dir, wt.path, ["README", "new.txt"]);
	assert.equal(readFileSync(join(wt.path, "README"), "utf8"), "edited\n");
	assert.equal(readFileSync(join(wt.path, "new.txt"), "utf8"), "new\n");
	assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }), "?? other.txt\n");
	assert.equal(execFileSync("git", ["stash", "list"], { cwd: dir, encoding: "utf8" }), "");
});

test("carry keeps the changes in the stash when they cannot apply in the worktree", async () => {
	const dir = repo();
	const wt = await createWorktree(dir, "carry");
	writeFileSync(join(wt.path, "new.txt"), "worktree\n");
	writeFileSync(join(dir, "new.txt"), "main\n");
	await assert.rejects(carryChanges(dir, wt.path, ["new.txt"]), /kept in stash/);
	assert.match(execFileSync("git", ["stash", "show", "--include-untracked", "-p"], { cwd: dir, encoding: "utf8" }), /\+main/);
});

test("remove refuses a worktree with uncommitted changes and keeps the branch", async () => {
	const dir = repo();
	const wt = await createWorktree(dir, "rm");
	writeFileSync(join(wt.path, "README"), "dirty\n");
	assert.match((await removeWorktree(dir, wt.path, false)) ?? "", /uncommitted/);
	assert.equal(existsSync(wt.path), true);
	execFileSync("git", ["commit", "-qam", "work"], { cwd: wt.path });
	assert.equal(await removeWorktree(dir, wt.path, false), undefined);
	assert.equal(existsSync(wt.path), false);
	execFileSync("git", ["rev-parse", "--verify", "refs/heads/rm"], { cwd: dir });
});

test("prune removes merged worktrees only, never unused, unmerged, or dirty ones", async () => {
	const dir = repo();
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
	const commit = (cwd: string, file: string) => {
		writeFileSync(join(cwd, file), `${file}\n`);
		git(cwd, "add", file);
		git(cwd, "commit", "-qm", file);
	};
	const merged = await createWorktree(dir, "merged");
	const dirty = await createWorktree(dir, "dirty");
	const unmerged = await createWorktree(dir, "unmerged");
	const unused = await createWorktree(dir, "unused");
	commit(merged.path, "m");
	commit(dirty.path, "d");
	commit(unmerged.path, "u");
	writeFileSync(join(dirty.path, "d"), "changed\n");
	git(dir, "merge", "-q", "--no-ff", "-m", "merge", "merged", "dirty");
	const removed = await pruneWorktrees(dir, "main");
	assert.deepEqual(removed, [`${merged.path} (merged)`]);
	for (const kept of [dirty, unmerged, unused]) assert.equal(existsSync(kept.path), true);
	assert.equal(git(dir, "branch", "--list", "merged"), "");
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

test("remapPath follows a symlinked alias of the checkout but not a symlinked file inside it", () => {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "ws-remap-")));
	const root = join(base, "repo");
	const wt = join(root, ".worktrees", "x");
	mkdirSync(root);
	symlinkSync(root, join(base, "alias"));
	symlinkSync("/etc/hosts", join(root, "link"));
	assert.equal(remapPath(join(base, "alias", "sub", "new.txt"), root, wt), join(wt, "sub", "new.txt"));
	assert.equal(remapPath(join(root, "link"), root, wt), join(wt, "link"));
	assert.equal(remapPath(join(base, "other.txt"), root, wt), join(base, "other.txt"));
});
