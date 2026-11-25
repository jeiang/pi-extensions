import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import workspace from "../extensions/workspace/index.ts";
import { grepRoute, lastLines, progressBar } from "../extensions/workspace/shell.ts";
import { childArgs, loadAgents, sessionExists } from "../extensions/workspace/subagent.ts";
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
		// shell is codemode-only; activating it declares it, as for a subagent that lists it.
		settings: { defaultTools: ["+shell"] },
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

test("a repository made during the session gets worktrees but no write block", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ws-new-")));
	const init = "git init -q -b main && git -c user.email=t@example.com -c user.name=t -c commit.gpgsign=false commit -q --allow-empty -m init";
	const { session: s } = await session(dir, [
		{ tool: "bash", args: { command: init } },
		{ tool: "write", args: { path: "a.txt", content: "a\n" } },
		{ tool: "worktree", args: { action: "create", name: "proto" } },
		{ tool: "write", args: { path: "b.txt", content: "b\n" } },
	]);
	await s.prompt("go");
	s.dispose();
	assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "a\n");
	assert.match(toolResults(s)[2] ?? "", /Now in worktree .*proto/);
	assert.equal(readFileSync(join(dir, ".worktrees", "proto", "b.txt"), "utf8"), "b\n");
});

test("a nested clone in the main checkout is neither blocked nor remapped; a submodule is", async () => {
	const dir = repo();
	mkdirSync(join(dir, "mod"));
	writeFileSync(join(dir, "mod", ".git"), "gitdir: ../.git/modules/mod\n");
	const { session: s } = await session(dir, [
		{ tool: "write", args: { path: "mod/c.txt", content: "c\n" } },
		{ tool: "bash", args: { command: "git init -q nested" } },
		{ tool: "write", args: { path: "nested/a.txt", content: "a\n" } },
		{ tool: "worktree", args: { action: "create", name: "wt" } },
		{ tool: "write", args: { path: join(dir, "nested", "b.txt"), content: "b\n" } },
	]);
	await s.prompt("go");
	s.dispose();
	assert.equal(readFileSync(join(dir, "nested", "a.txt"), "utf8"), "a\n");
	assert.equal(readFileSync(join(dir, "nested", "b.txt"), "utf8"), "b\n");
	assert.match(toolResults(s)[0] ?? "", /worktree tool first/);
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

test("prune removes merged and squash-merged worktrees only, never unused, unmerged, extended, trimmed, dirty, or nested ones", async () => {
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
	const squashed = await createWorktree(dir, "squashed");
	const extended = await createWorktree(dir, "extended");
	const trimmed = await createWorktree(dir, "trimmed");
	commit(merged.path, "m");
	commit(dirty.path, "d");
	commit(unmerged.path, "u");
	writeFileSync(join(dirty.path, "d"), "changed\n");
	const nested = join(dir, ".worktrees", "project", "child");
	git(dir, "worktree", "add", "-q", "-b", "pi-subagents/child", nested, "main");
	commit(nested, "n");
	git(dir, "merge", "-q", "--no-ff", "-m", "merge", "merged", "dirty", "pi-subagents/child");
	commit(squashed.path, "s1");
	commit(squashed.path, "s2");
	commit(extended.path, "e1");
	commit(trimmed.path, "t1");
	commit(trimmed.path, "t2");
	for (const branch of ["squashed", "extended", "trimmed"]) {
		git(dir, "merge", "-q", "--squash", branch);
		git(dir, "commit", "-qm", `squash ${branch}`);
	}
	commit(extended.path, "e2");
	// Undoing part of the branch after its squash merge leaves a merge into main unchanged.
	git(trimmed.path, "rm", "-q", "t2");
	git(trimmed.path, "commit", "-qm", "drop t2");
	// A later edit on main to a squashed file makes a merge of the branch into main's tip conflict.
	writeFileSync(join(dir, "s1"), "edited\n");
	git(dir, "commit", "-qam", "edit s1");
	const tip = (branch: string) => git(dir, "rev-parse", "--short=12", branch).trim();
	const tips = { merged: tip("merged"), squashed: tip("squashed") };
	const removed = await pruneWorktrees(dir, "main");
	assert.deepEqual(removed.sort(), [`${merged.path} (merged at ${tips.merged})`, `${squashed.path} (squashed at ${tips.squashed})`]);
	for (const kept of [dirty.path, unmerged.path, unused.path, extended.path, trimmed.path, nested]) assert.equal(existsSync(kept), true);
	assert.equal(git(dir, "branch", "--list", "merged", "squashed"), "");
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

test("tail reports truncated only when it left output out", () => {
	assert.deepEqual(lastLines("a\nb\nc\n", 20), { content: "a\nb\nc", truncated: false });
	assert.deepEqual(lastLines("a\nb\nc\n", 2), { content: "b\nc", truncated: true });
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

test("subagent arguments keep the child to its agent's model, tools, and extensions", () => {
	const dir = mkdtempSync(join(tmpdir(), "ws-agents-"));
	writeFileSync(
		join(dir, "scout.md"),
		"---\nname: scout\ndescription: Finds code.\nmodel: chain/light\ntools: read, shell\nextensions: ~/x/chains, /abs/guards\ninheritProjectContext: false\n---\n\nYou explore.\n",
	);
	writeFileSync(join(dir, "plain.md"), "---\nname: plain\ndescription: No limits.\n---\n");
	const [plain, scout] = loadAgents(dir);
	assert.ok(plain && scout);
	assert.deepEqual(childArgs(scout, "find it", "/s"), [
		"--mode", "json", "-p", "--model", "chain/light", "--tools", "read,shell", "-ne", "-e", join(homedir(), "x/chains"), "-e", "/abs/guards",
		"--append-system-prompt", "You explore.", "-nc", "--session-dir", "/s", "--", "find it",
	]);
	// An agent without a tool list must still not get the subagent tool.
	assert.deepEqual(childArgs(plain, "t", undefined), ["--mode", "json", "-p", "--exclude-tools", "subagent", "-ne", "--no-session", "--", "t"]);
	// A session id reopens that transcript, which is what resuming a stopped child needs.
	assert.deepEqual(childArgs(scout, "go on", "/s", "0190-abc").slice(-4), ["--session-id", "0190-abc", "--", "go on"]);
});

test("a child session is found by the id pi put in its transcript's name", () => {
	const dir = mkdtempSync(join(tmpdir(), "ws-sessions-"));
	assert.equal(sessionExists(dir, "0190-abc"), false);
	writeFileSync(join(dir, "2026-01-01T00-00-00-000Z_0190-abc.jsonl"), "");
	assert.equal(sessionExists(dir, "0190-abc"), true);
	assert.equal(sessionExists(dir, "0190-ab"), false);
	assert.equal(sessionExists(join(dir, "absent"), "0190-abc"), false);
});

test("progressBar reads build steps and percentages", () => {
	assert.equal(progressBar("[3/12] Compiling foo"), `${"█".repeat(6)}${"░".repeat(18)} 25%`);
	assert.equal(progressBar("copied 3 of 4 files"), `${"█".repeat(18)}${"░".repeat(6)} 75%`);
	assert.equal(progressBar("  45% 1.2MB/s"), `${"█".repeat(11)}${"░".repeat(13)} 45%`);
	assert.equal(progressBar("exit 250%"), undefined);
	assert.equal(progressBar("plain line"), undefined);
});

test("a carriage-return progress line updates in place in the live view", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ws-live-"));
	const { session: s } = await session(dir, [{ tool: "shell", args: { command: "printf 'start\\n10%%\\r50%%\\r'; sleep 0.3; printf '100%%\\ndone\\n'" } }]);
	const views: string[] = [];
	s.subscribe((event) => {
		if (event.type === "tool_execution_update") views.push(event.partialResult.content[0]?.text ?? "");
	});
	await s.prompt("run");
	s.dispose();
	assert.equal(views.at(-1), "start\n100%\ndone");
	assert.ok(views.some((view) => view.startsWith("start\n50%\n█")), views.join("\n---\n"));
	assert.match(toolResults(s)[0] ?? "", /10%\r50%\r100%\ndone/);
});
