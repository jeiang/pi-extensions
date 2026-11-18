import { execFile } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, readFileSync, readlinkSync, symlinkSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
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

async function baseRef(root: string): Promise<string> {
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

/** Creates `.worktrees/<name>` on a new branch `<name>` from the default branch, without touching the main checkout. */
export async function createWorktree(root: string, name: string): Promise<{ path: string; branch: string; base: string }> {
	let branch = slug(name);
	for (let n = 2; (await tryGit(root, "rev-parse", "--verify", "-q", `refs/heads/${branch}`)) || existsSync(join(root, ".worktrees", branch)); n++) {
		branch = `${slug(name)}-${n}`;
	}
	const path = join(root, ".worktrees", branch);
	if ((await tryGit(root, "check-ignore", "-q", path)) === undefined) {
		const exclude = resolve(root, await git(root, "rev-parse", "--git-path", "info/exclude"));
		await appendFile(exclude, "\n.worktrees/\n");
	}
	const base = await baseRef(root);
	await git(root, "worktree", "add", "--quiet", "-b", branch, path, base);
	await git(path, "branch", "--quiet", "--unset-upstream").catch(() => undefined);
	const hooks = join(root, ".pre-commit-config.yaml");
	if (existsSync(hooks) && !existsSync(join(path, ".pre-commit-config.yaml"))) {
		if (lstatSync(hooks).isSymbolicLink()) symlinkSync(readlinkSync(hooks), join(path, ".pre-commit-config.yaml"));
		else copyFileSync(hooks, join(path, ".pre-commit-config.yaml"));
	}
	await allowDirenv(root, path);
	return { path, branch, base };
}

async function allowDirenv(root: string, worktree: string) {
	const main = join(root, ".envrc");
	const copy = join(worktree, ".envrc");
	if (!existsSync(main) || !existsSync(copy) || readFileSync(main, "utf8") !== readFileSync(copy, "utf8")) return;
	if (!(await direnvAllowed(root))) return;
	await run("direnv", ["allow", worktree]).catch(() => undefined);
}

/** Maps a path under the main checkout to the same path in the worktree; leaves others alone. */
export function remapPath(path: string, root: string, worktree: string): string {
	const raw = path.replace(/^@/, "");
	if (!isAbsolute(raw)) return raw;
	const rel = relative(root, raw);
	if (rel.startsWith("..") || isAbsolute(rel) || rel === ".worktrees" || rel.startsWith(".worktrees/")) return raw;
	return join(worktree, rel);
}

export const GIT_MUTATION = /\bgit\s+(add|commit|checkout|switch|merge|rebase|reset|stash|cherry-pick|revert|am|restore|branch\s+-[dDmM]|worktree\s+remove)\b/;
