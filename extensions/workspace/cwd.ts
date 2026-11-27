import { resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { remapPath } from "./worktree.ts";

// pi loads each extension separately, so a module-level map would not be shared between them.
const KEY = Symbol.for("pi-extensions.workspace.dirs");
const ROOTS = Symbol.for("pi-extensions.workspace.roots");
const store = globalThis as typeof globalThis & { [KEY]?: Map<string, string>; [ROOTS]?: Map<string, string> };
const dirs = (store[KEY] ??= new Map<string, string>());
const roots = (store[ROOTS] ??= new Map<string, string>());

/** `root` is the main checkout when `dir` is one of its worktrees, so paths under it map into `dir`. */
export function setSessionDir(ctx: ExtensionContext, dir: string | undefined, root?: string) {
	const id = ctx.sessionManager.getSessionId();
	if (dir) dirs.set(id, dir);
	else dirs.delete(id);
	if (dir && root && root !== dir) roots.set(id, root);
	else roots.delete(id);
}

/** The directory the session works in: its worktree when the workspace extension made one, else `ctx.cwd`. */
export function sessionDir(ctx: ExtensionContext): string {
	return dirs.get(ctx.sessionManager.getSessionId()) ?? ctx.cwd;
}

/** An absolute path for a tool argument: relative to the session directory, a main-checkout path mapped into the worktree. */
export function sessionPath(ctx: ExtensionContext, path: string): string {
	const dir = sessionDir(ctx);
	const root = roots.get(ctx.sessionManager.getSessionId());
	const raw = path.replace(/^@/, "");
	return resolve(dir, root ? remapPath(raw, root, dir) : raw);
}
