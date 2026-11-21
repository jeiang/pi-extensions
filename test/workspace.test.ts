import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import workspace from "../extensions/workspace/index.ts";
import { inlinePython } from "../extensions/workspace/python.ts";
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

test("carry with no changes leaves an existing stash alone", async () => {
	const dir = repo();
	const wt = await createWorktree(dir, "carry");
	writeFileSync(join(dir, "README"), "user stash\n");
	execFileSync("git", ["stash", "push", "-q"], { cwd: dir });
	await assert.rejects(carryChanges(dir, wt.path, ["README"]), /No changes/);
	assert.equal(readFileSync(join(wt.path, "README"), "utf8"), "hi\n");
	assert.match(execFileSync("git", ["stash", "show", "-p"], { cwd: dir, encoding: "utf8" }), /\+user stash/);
});

test("a session removes its worktree, is blocked again, and enters or creates another", async () => {
	const dir = repo();
	const { session: s } = await session(dir, [
		{ tool: "worktree", args: { action: "create", name: "first" } },
		{ tool: "write", args: { path: "a.txt", content: "a\n" } },
		{ tool: "bash", args: { command: "git add a.txt && git commit -qm a" } },
		{ tool: "worktree", args: { action: "remove" } },
		{ tool: "write", args: { path: "b.txt", content: "b\n" } },
		{ tool: "worktree", args: { action: "enter", name: "first" } },
		{ tool: "worktree", args: { action: "remove" } },
		{ tool: "worktree", args: { action: "create", name: "second" } },
		{ tool: "write", args: { path: "c.txt", content: "c\n" } },
	]);
	await s.prompt("go");
	s.dispose();
	const results = toolResults(s);
	assert.match(results[4] ?? "", /worktree tool first/);
	assert.match(results[5] ?? "", /Now in worktree .*first/);
	assert.equal(existsSync(join(dir, ".worktrees", "first")), false);
	assert.equal(readFileSync(join(dir, ".worktrees", "second", "c.txt"), "utf8"), "c\n");
	assert.equal(execFileSync("git", ["show", "first:a.txt"], { cwd: dir, encoding: "utf8" }), "a\n");
	assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }), "");
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

test("prune removes merged worktrees only, never unused, unmerged, dirty, or nested ones", async () => {
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
	const nested = join(dir, ".worktrees", "project", "child");
	git(dir, "worktree", "add", "-q", "-b", "pi-subagents/child", nested, "main");
	commit(nested, "n");
	git(dir, "merge", "-q", "--no-ff", "-m", "merge", "merged", "dirty", "pi-subagents/child");
	const removed = await pruneWorktrees(dir, "main");
	assert.deepEqual(removed, [`${merged.path} (merged)`]);
	for (const kept of [dirty.path, unmerged.path, unused.path, nested]) assert.equal(existsSync(kept), true);
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

test("inlinePython blocks inline code and bare interpreters, not scripts or modules", () => {
	for (const command of [
		"python3 -c 'print(1)'",
		"python -u -c 'print(1)'",
		"python3 - <<'EOF'\nprint(1)\nEOF",
		"python3 <<EOF\nprint(1)\nEOF",
		"curl -s x | python3 -c 'import json'",
		"cat data | python3",
		"cd src && uv run python -c 'import x'",
		"nix develop -c python3 -c 'print(1)'",
		"/usr/bin/python3.12 -c 1",
		"ssh host bash -c 'python3 -c 1'",
		"python3",
	])
		assert.equal(inlinePython(command), true, command);
	for (const command of [
		"python3 android/tools/livery_fixture.py --out x",
		"python -X dev script.py",
		"python3 -m pytest -q",
		"uv run python scripts/gen.py",
		"python3 \"$SCRIPT\" --flag",
		"which python3",
		"python3 --version",
		"echo python -c",
		"nix shell nixpkgs#python3 -c true",
		"git commit -m 'python -c fix'",
	])
		assert.equal(inlinePython(command), false, command);
});

test("the python kernel keeps state between calls, survives errors, and interrupts on timeout", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ws-python-"));
	const { session: s } = await session(dir, [
		{ tool: "python", args: { code: "import os\nx = 41\nprint('hi')" } },
		{ tool: "python", args: { code: "x + 1" } },
		{ tool: "python", args: { code: "1/0" } },
		{ tool: "python", args: { code: "import time\ntime.sleep(30)", timeout: 1 } },
		{ tool: "python", args: { code: "import subprocess\nsubprocess.run(['sleep', '30'])", timeout: 1 } },
		{ tool: "python", args: { code: "os.system('echo from-child'); x" } },
		{ tool: "shell", args: { command: "python3 -c 'print(1)'" } },
	]);
	const started = Date.now();
	await s.prompt("compute");
	s.dispose();
	const [first, second, third, fourth, fifth, sixth, seventh] = toolResults(s);
	assert.equal(first, "hi");
	assert.equal(second, "42");
	assert.match(third ?? "", /ZeroDivisionError/);
	assert.match(fourth ?? "", /KeyboardInterrupt[\s\S]*Interrupted after 1s/);
	assert.match(fifth ?? "", /Interrupted after 1s/);
	assert.match(sixth ?? "", /from-child[\s\S]*41/);
	assert.match(seventh ?? "", /persistent kernel/);
	assert.ok(Date.now() - started < 10_000);
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
