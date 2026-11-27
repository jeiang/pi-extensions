import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cacheUsable, fromNulEnv } from "../extensions/workspace/devshell.ts";
import workspace from "../extensions/workspace/index.ts";
import { jobCommand, lastLines, progressBar, ttyCommand, ttyOutput, waitBound } from "../extensions/workspace/shell.ts";
import { childArgs, loadAgents, sessionDigest, sessionExists, sessionTail } from "../extensions/workspace/subagent.ts";
import { carryChanges, createWorktree, fastForwardBranch, pruneWorktrees, remapPath, removeWorktree } from "../extensions/workspace/worktree.ts";
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
		// run is codemode-only; activating it declares it, as for a subagent that lists it.
		settings: { defaultTools: ["+run"] },
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
		{ tool: "run", args: { command: init } },
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
		{ tool: "run", args: { command: "git init -q nested" } },
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
		{ tool: "run", args: { command: "git add a.txt && git commit -qm a" } },
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

test("ff_main fast-forwards main in the main checkout or by ref, and refuses a diverged branch", async () => {
	const dir = repo();
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
	const feat = await createWorktree(dir, "feat");
	writeFileSync(join(feat.path, "README"), "feat\n");
	git(feat.path, "commit", "-qam", "feat");
	assert.match(await fastForwardBranch(dir, "main", "feat"), /fast-forwarded/);
	assert.equal(readFileSync(join(dir, "README"), "utf8"), "feat\n");
	git(dir, "branch", "side", "main~1");
	await fastForwardBranch(dir, "side", "main");
	assert.equal(git(dir, "rev-parse", "side"), git(dir, "rev-parse", "main"));
	writeFileSync(join(dir, "other"), "x\n");
	git(dir, "add", "other");
	git(dir, "commit", "-qm", "main moves");
	writeFileSync(join(feat.path, "README"), "feat 2\n");
	git(feat.path, "commit", "-qam", "feat 2");
	const before = git(dir, "rev-parse", "main");
	await assert.rejects(fastForwardBranch(dir, "main", "feat"), /does not contain main/);
	assert.equal(git(dir, "rev-parse", "main"), before);
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

test("prune removes merged, squash-merged, fast-forwarded, unused, and detached worktrees only, never unmerged, extended, dirty, or nested ones", async () => {
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
	// A branch fast-forwarded into main sits exactly on main's tip; that is still merged work.
	const fastForwarded = await createWorktree(dir, "fast-forwarded");
	commit(fastForwarded.path, "ff");
	git(dir, "merge", "-q", "--ff-only", "fast-forwarded");
	const detached = join(dir, ".worktrees", "detached");
	git(dir, "worktree", "add", "-q", "--detach", detached, "main");
	const tip = (branch: string) => git(dir, "rev-parse", "--short=12", branch).trim();
	const detachedTip = git(detached, "rev-parse", "--short=12", "HEAD").trim();
	const tips = { merged: tip("merged"), squashed: tip("squashed"), unused: tip("unused"), fastForwarded: tip("fast-forwarded") };
	const removed = await pruneWorktrees(dir, "main");
	assert.deepEqual(
		removed.sort(),
		[
			`${merged.path} (merged at ${tips.merged})`,
			`${squashed.path} (squashed at ${tips.squashed})`,
			`${unused.path} (unused at ${tips.unused})`,
			`${fastForwarded.path} (fast-forwarded at ${tips.fastForwarded})`,
			`${detached} (detached at ${detachedTip})`,
		].sort(),
	);
	for (const kept of [dirty.path, unmerged.path, extended.path, trimmed.path, nested]) assert.equal(existsSync(kept), true);
	assert.equal(git(dir, "branch", "--list", "merged", "squashed", "unused", "fast-forwarded"), "");
});

test("exit removes a worktree the session started in, deletes its merged branch, and returns to the main checkout", async () => {
	const dir = repo();
	const wt = await createWorktree(dir, "exit-merged");
	writeFileSync(join(wt.path, "x"), "x\n");
	execFileSync("git", ["add", "x"], { cwd: wt.path });
	execFileSync("git", ["commit", "-qm", "x"], { cwd: wt.path });
	execFileSync("git", ["merge", "-q", "--ff-only", "exit-merged"], { cwd: dir });
	const { session: s } = await session(wt.path, [
		{ tool: "worktree", args: { action: "exit" } },
		{ tool: "worktree", args: { action: "list" } },
		{ tool: "run", args: { command: "pwd" } },
	]);
	await s.prompt("leave");
	s.dispose();
	assert.equal(existsSync(wt.path), false);
	assert.equal(execFileSync("git", ["branch", "--list", "exit-merged"], { cwd: dir, encoding: "utf8" }), "");
	assert.match(toolResults(s).at(-2) ?? "", /No worktrees/);
	assert.ok((toolResults(s).at(-1) ?? "").split("\n").includes(dir));
});

test("exit keeps the branch when its work is not merged", async () => {
	const dir = repo();
	const wt = await createWorktree(dir, "exit-open");
	writeFileSync(join(wt.path, "y"), "y\n");
	execFileSync("git", ["add", "y"], { cwd: wt.path });
	execFileSync("git", ["commit", "-qm", "y"], { cwd: wt.path });
	const { session: s } = await session(wt.path, [{ tool: "worktree", args: { action: "exit" } }]);
	await s.prompt("leave");
	s.dispose();
	assert.equal(existsSync(wt.path), false);
	assert.equal(execFileSync("git", ["branch", "--list", "exit-open"], { cwd: dir, encoding: "utf8" }).trim(), "exit-open");
});

test("exit removes a worktree the session created and returns to the main checkout", async () => {
	const dir = repo();
	const { session: s } = await session(dir, [
		{ tool: "worktree", args: { action: "create", name: "exit-own" } },
		{ tool: "worktree", args: { action: "exit" } },
		{ tool: "run", args: { command: "pwd" } },
	]);
	await s.prompt("leave");
	s.dispose();
	assert.equal(existsSync(join(dir, ".worktrees", "exit-own")), false);
	assert.equal(execFileSync("git", ["branch", "--list", "exit-own"], { cwd: dir, encoding: "utf8" }), "");
	assert.ok((toolResults(s).at(-1) ?? "").split("\n").includes(dir));
});

test("a background job returns at the first matching line and keeps running", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ws-shell-"));
	const { session: s } = await session(dir, [
		{ tool: "run", args: { command: "echo starting; echo READY; sleep 5; echo late", background: true, wait_on: "READY" } },
		{ tool: "job", args: { action: "kill", job: "job1" } },
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

test("killing a tty job kills the pty's own session, not only the outer shell", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ws-tty-"));
	const pidFile = join(dir, "child.pid");
	const { session: s } = await session(dir, [
		{ tool: "run", args: { command: `trap '' HUP; echo $$ > '${pidFile}'; sleep 60`, background: true, tty: true, wait_seconds: 1 } },
		{ tool: "job", args: { action: "kill", job: "job1" } },
	]);
	await s.prompt("serve");
	s.dispose();
	const pid = Number(readFileSync(pidFile, "utf8").trim());
	assert.ok(Number.isInteger(pid) && pid > 1, `no pid in ${pidFile}`);
	assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test("an absolute cwd runs where it names, not in the worktree", async () => {
	const dir = repo();
	const { session: s } = await session(dir, [
		{ tool: "worktree", args: { action: "create", name: "cwd" } },
		{ tool: "run", args: { command: "pwd", cwd: dir } },
	]);
	await s.prompt("check");
	s.dispose();
	assert.ok((toolResults(s).at(-1) ?? "").split("\n").includes(dir));
});

test("a read-only path falls back to the main checkout only when the worktree lacks it", async () => {
	const dir = repo();
	writeFileSync(join(dir, "main-only.txt"), "main\n");
	const { session: s } = await session(dir, [
		{ tool: "worktree", args: { action: "create", name: "read-main" } },
		{ tool: "write", args: { path: "README", content: "worktree\n" } },
		{ tool: "read", args: { path: join(dir, "README") } },
		{ tool: "read", args: { path: join(dir, "main-only.txt") } },
	]);
	await s.prompt("read");
	s.dispose();
	const [mapped, fallback] = toolResults(s).slice(-2);
	assert.match(mapped ?? "", /worktree/);
	assert.match(fallback ?? "", /main/);
});

test("a devshell env from nix develop drops the shell's own variables", () => {
	assert.deepEqual(fromNulEnv("PATH=/nix/store/x/bin\0PWD=/repo\0OLDPWD=/old\0SHLVL=2\0_=/bin/env\0NIX_CFLAGS_COMPILE= -frandom-seed=x\0"), {
		PATH: "/nix/store/x/bin",
		NIX_CFLAGS_COMPILE: " -frandom-seed=x",
	});
});

test("tail reports truncated only when it left output out", () => {
	assert.deepEqual(lastLines("a\nb\nc\n", 20), { content: "a\nb\nc", truncated: false });
	assert.deepEqual(lastLines("a\nb\nc\n", 2), { content: "b\nc", truncated: true });
});

test("a child's transcript tail shows its last text, tool calls, and results", () => {
	const dir = mkdtempSync(join(tmpdir(), "ws-tail-"));
	const id = "0190-tail";
	writeFileSync(
		join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`),
		[
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Looking at the parser." }, { type: "toolCall", name: "read", input: { path: "src/a.ts" } }] } }),
			JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "export function a() {}" }] } }),
		].join("\n"),
	);
	assert.deepEqual(sessionTail(dir, id), ["say Looking at the parser.", "read src/a.ts", "  → export function a() {}"]);
	assert.deepEqual(sessionTail(dir, "missing"), []);
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
	assert.equal(remapPath(".worktrees/other/a.txt", root, wt), join(root, ".worktrees", "other", "a.txt"));
	assert.equal(remapPath("src/a.txt", root, wt), "src/a.txt");
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

test("the digest tells a throwaway child where the session stands", () => {
	const entries = [
		{ type: "custom", customType: "checkpoint", data: { state: "done: x\nnext: y", at: "t" } },
		{ type: "message", message: { role: "user", content: [{ type: "text", text: "wire the parser" }] } },
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", name: "edit", input: { input: "[src/a.ts#ABCD]\nPUT 1.=1:\n+x" } },
					{ type: "toolCall", name: "run", input: { command: "bun test" } },
				],
			},
		},
	];
	const digest = sessionDigest(entries, "is the parser wired?");
	assert.match(digest, /Checkpoint:\ndone: x/);
	assert.match(digest, /Last request from the user:\nwire the parser/);
	assert.match(digest, /edit src\/a\.ts/);
	assert.match(digest, /run bun test/);
	assert.match(digest, /Files touched:\nsrc\/a\.ts/);
	assert.match(digest, /is the parser wired\?$/);
});

test("the tty wrapper differs by platform and quotes the command", () => {
	assert.equal(ttyCommand("sudo true", "darwin"), "/usr/bin/script -q /dev/null bash -c 'sudo true'");
	assert.equal(ttyCommand("sudo true", "linux"), "script -qec 'sudo true' /dev/null");
});

test("a pty's EOF marker and CRLF leave the output", () => {
	assert.equal(ttyOutput("^D\b\bhi\r\nerr\r\n"), "hi\nerr\n");
	// A carriage return that redraws a progress line survives; only CRLF is a newline.
	assert.equal(ttyOutput("50%\r100%\r\n"), "50%\r100%\n");
});

test("a pty job keeps the stderr redirect inside the pty", () => {
	assert.equal(jobCommand("ls", "/tmp/e", true), ttyCommand("{ ls\n} 2> '/tmp/e'"));
	// Without a pty, sudo fails at once instead of waiting for a password; stdin comes from a file.
	assert.equal(jobCommand("ls", "/tmp/e", false, undefined, "/tmp/in"), `{ sudo() { command sudo -n "$@"; }\nls\n} 2> '/tmp/e' < '/tmp/in'`);
});
test("a wait with no selector is bounded, and a selector is not", () => {
	assert.equal(waitBound({}), 120);
	assert.equal(waitBound({}), 120);
	assert.equal(waitBound({ wait_seconds: 5 }), 5);
	assert.equal(waitBound({ wait_on: "READY" }), undefined);
	assert.equal(waitBound({ wait_on: "READY", wait_seconds: 5 }), 5);
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
	const { session: s } = await session(dir, [{ tool: "run", args: { command: "printf 'start\\n10%%\\r50%%\\r'; sleep 0.3; printf '100%%\\ndone\\n'" } }]);
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

test("a cached devshell that names a store path the store lost is a miss", () => {
	assert.equal(cacheUsable({ PATH: "/usr/bin:/bin" }), true);
	assert.equal(cacheUsable({ PATH: "/nix/store/00000000000000000000000000000000-gone/bin" }), false);
});
