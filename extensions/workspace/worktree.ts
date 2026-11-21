import { execFile } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, symlinkSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { direnvAllowed } from "./devshell.ts";

const run = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await run("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
	return stdout.trim();
}

async function tryGit(cwd: string, ...args: string[]): Promise<string | undefined> {
	try {
		return await git(cwd, ...args);
	} catch {
		return undefined;
	}
}

export interface Repo {
	/** Top level of the checkout the session started in. */
	root: string;
	/** True when that checkout is a linked worktree. */
	linked: boolean;
	/** False for a repository without commits, which has nothing to branch from. */
	hasCommits: boolean;
}

export async function detectRepo(cwd: string): Promise<Repo | undefined> {
	const root = await tryGit(cwd, "rev-parse", "--show-toplevel");
	if (!root) return undefined;
	const gitDir = resolve(cwd, (await tryGit(cwd, "rev-parse", "--git-dir")) ?? ".git");
	const commonDir = resolve(cwd, (await tryGit(cwd, "rev-parse", "--git-common-dir")) ?? ".git");
	const hasCommits = (await tryGit(cwd, "rev-parse", "--verify", "-q", "HEAD")) !== undefined;
	return { root, linked: gitDir !== commonDir, hasCommits };
}

export function slug(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.split("-")
			.slice(0, 5)
			.join("-")
			.slice(0, 40)
			.replace(/-+$/, "") || "work"
	);
}

export async function baseRef(root: string): Promise<string> {
	const remote = await tryGit(root, "remote");
	if (remote?.split("\n").includes("origin")) {
		await tryGit(root, "fetch", "--quiet", "origin");
		const head = await tryGit(root, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
		if (head) return head;
		for (const name of ["main", "master"]) {
			if (await tryGit(root, "rev-parse", "--verify", "-q", `refs/remotes/origin/${name}`)) return `origin/${name}`;
		}
	}
	for (const name of ["main", "master"]) {
		if (await tryGit(root, "rev-parse", "--verify", "-q", `refs/heads/${name}`)) return name;
	}
	return "HEAD";
}

async function ignoreWorktrees(root: string, path: string) {
	if ((await tryGit(root, "check-ignore", "-q", path)) !== undefined) return;
	const exclude = resolve(root, await git(root, "rev-parse", "--git-path", "info/exclude"));
	await appendFile(exclude, "\n.worktrees/\n");
}

/** A free `.worktrees/<dir>` path for a branch name, suffixed `-2`, `-3`... when taken. */
async function freePath(root: string, name: string, branchTaken: boolean): Promise<{ dir: string; path: string }> {
	let dir = slug(name);
	const taken = async (d: string) => existsSync(join(root, ".worktrees", d)) || (branchTaken && (await tryGit(root, "rev-parse", "--verify", "-q", `refs/heads/${d}`)) !== undefined);
	for (let n = 2; await taken(dir); n++) dir = `${slug(name)}-${n}`;
	return { dir, path: join(root, ".worktrees", dir) };
}

async function prepare(root: string, path: string) {
	const hooks = join(root, ".pre-commit-config.yaml");
	if (existsSync(hooks) && !existsSync(join(path, ".pre-commit-config.yaml"))) {
		if (lstatSync(hooks).isSymbolicLink()) symlinkSync(readlinkSync(hooks), join(path, ".pre-commit-config.yaml"));
		else copyFileSync(hooks, join(path, ".pre-commit-config.yaml"));
	}
	await allowDirenv(root, path);
}

export interface Worktree {
	path: string;
	branch: string;
	base: string;
}

/** Creates `.worktrees/<name>` on a new branch `<name>` from the default branch, without touching the main checkout. */
export async function createWorktree(root: string, name: string): Promise<Worktree> {
	const { dir: branch, path } = await freePath(root, name, true);
	await ignoreWorktrees(root, path);
	const base = await baseRef(root);
	await git(root, "worktree", "add", "--quiet", "-b", branch, path, base);
	await git(path, "branch", "--quiet", "--unset-upstream").catch(() => undefined);
	await prepare(root, path);
	return { path, branch, base };
}

interface Listed {
	path: string;
	branch?: string;
}

async function listWorktrees(root: string): Promise<Listed[]> {
	return (await git(root, "worktree", "list", "--porcelain")).split("\n\n").map((block) => {
		const lines = block.split("\n");
		const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length) ?? "";
		const branch = lines.find((line) => line.startsWith("branch "))?.slice("branch refs/heads/".length);
		return { path, branch };
	});
}

/** Worktrees this extension manages: direct children of `.worktrees/`; pi-subagents nests its own one level deeper. */
export async function ownWorktrees(root: string): Promise<Listed[]> {
	return (await listWorktrees(root)).filter((w) => dirname(w.path) === join(root, ".worktrees"));
}

/** Returns the worktree of an existing local or `origin` branch, adding one under `.worktrees/` if none exists. */
export async function enterWorktree(root: string, branch: string): Promise<Worktree> {
	const existing = (await listWorktrees(root)).find((w) => w.branch === branch);
	if (existing?.path === root) throw new Error(`${branch} is checked out in the main checkout; create a new branch instead.`);
	if (existing) return { path: existing.path, branch, base: branch };
	await tryGit(root, "fetch", "--quiet", "origin");
	const local = (await tryGit(root, "rev-parse", "--verify", "-q", `refs/heads/${branch}`)) !== undefined;
	if (!local && (await tryGit(root, "rev-parse", "--verify", "-q", `refs/remotes/origin/${branch}`)) === undefined)
		throw new Error(`No branch ${branch} locally or on origin.`);
	const { path } = await freePath(root, branch, false);
	await ignoreWorktrees(root, path);
	if (local) await git(root, "worktree", "add", "--quiet", path, branch);
	else await git(root, "worktree", "add", "--quiet", "--track", "-b", branch, path, `origin/${branch}`);
	await prepare(root, path);
	return { path, branch, base: local ? branch : `origin/${branch}` };
}

/** Removes a worktree and keeps its branch. Returns a refusal instead when it has uncommitted changes and `force` is unset. */
export async function removeWorktree(root: string, path: string, force: boolean): Promise<string | undefined> {
	const dirty = await git(path, "status", "--porcelain");
	if (dirty && !force) return `${path} has uncommitted changes:\n${dirty}\nCommit them, or pass force to discard them.`;
	await git(root, "worktree", "remove", ...(force ? ["--force"] : []), path);
	return undefined;
}

/** Removes clean worktrees, and their branches, whose work is merged into `base`. */
export async function pruneWorktrees(root: string, base: string): Promise<string[]> {
	// main merges pull requests with merge commits, so an unused branch sits on its first-parent line and merged work does not.
	const mainline = new Set((await git(root, "rev-list", "--first-parent", base)).split("\n"));
	const removed: string[] = [];
	for (const w of await ownWorktrees(root)) {
		if (!w.branch) continue;
		const tip = await tryGit(root, "rev-parse", w.branch);
		if (!tip || mainline.has(tip) || (await tryGit(root, "merge-base", "--is-ancestor", tip, base)) === undefined) continue;
		if ((await tryGit(w.path, "status", "--porcelain")) !== "") continue;
		await git(root, "worktree", "remove", w.path);
		await tryGit(root, "branch", "-D", w.branch);
		removed.push(`${w.path} (${w.branch})`);
	}
	await tryGit(root, "worktree", "prune");
	return removed;
}

/** Moves uncommitted changes to `paths` from the main checkout into `worktree` through one stash entry. */
export async function carryChanges(root: string, worktree: string, paths: string[]): Promise<string> {
	const before = await tryGit(root, "rev-parse", "-q", "--verify", "refs/stash");
	await git(root, "stash", "push", "--include-untracked", "--quiet", "-m", "worktree carry", "--", ...paths);
	const stash = await tryGit(root, "rev-parse", "-q", "--verify", "refs/stash");
	if (!stash || stash === before) throw new Error(`No changes to ${paths.join(", ")} in the main checkout.`);
	try {
		if ((await git(worktree, "rev-parse", "stash@{0}")) !== stash) throw new Error("another stash was pushed meanwhile");
		await git(worktree, "stash", "pop", "--quiet", "stash@{0}");
	} catch (error) {
		throw new Error(`Removed the changes from the main checkout but could not apply them here; they are kept in stash ${stash}:\n${(error as Error).message}`);
	}
	return git(worktree, "status", "--short", "--", ...paths);
}

/** Fast-forwards the main checkout to `base` when it is on that branch; a local edit that conflicts leaves it as is. */
export async function fastForwardMain(root: string, base: string) {
	if (!base.startsWith("origin/") || (await tryGit(root, "branch", "--show-current")) !== base.slice("origin/".length)) return;
	await tryGit(root, "merge", "--ff-only", "--quiet", base);
}

async function allowDirenv(root: string, worktree: string) {
	const main = join(root, ".envrc");
	const copy = join(worktree, ".envrc");
	if (!existsSync(main) || !existsSync(copy) || readFileSync(main, "utf8") !== readFileSync(copy, "utf8")) return;
	if (!(await direnvAllowed(root))) return;
	await run("direnv", ["allow", worktree]).catch(() => undefined);
}

/** Resolves symlinks in the directories of a path that may not exist yet, keeping its last component. */
function realDir(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		const parent = dirname(path);
		return parent === path ? path : join(realDir(parent), basename(path));
	}
}

/** The path of an absolute `path` relative to the main checkout, or undefined outside it or under `.worktrees/`. */
export function checkoutRelative(path: string, root: string): string | undefined {
	const outside = (rel: string) => rel.startsWith("..") || isAbsolute(rel);
	let rel = relative(root, path);
	// git reports the real root, so /tmp/repo on macOS arrives as /private/tmp/repo.
	if (outside(rel)) rel = relative(root, join(realDir(dirname(path)), basename(path)));
	if (outside(rel) || rel === ".worktrees" || rel.startsWith(".worktrees/")) return undefined;
	return rel;
}

/** Maps a path under the main checkout to the same path in the worktree; leaves others alone. */
export function remapPath(path: string, root: string, worktree: string): string {
	const raw = path.replace(/^@/, "");
	if (!isAbsolute(raw)) return raw;
	const rel = checkoutRelative(raw, root);
	return rel === undefined ? raw : join(worktree, rel);
}

export const GIT_MUTATION = /\bgit\s+(add|commit|checkout|switch|merge|rebase|reset|stash|cherry-pick|revert|am|restore|branch\s+-[dDmM]|worktree\s+remove)\b/;
