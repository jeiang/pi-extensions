import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// pi loads each extension separately, so a module-level map would not be shared between them.
const KEY = Symbol.for("pi-extensions.workspace.dirs");
const store = globalThis as typeof globalThis & { [KEY]?: Map<string, string> };
const dirs = (store[KEY] ??= new Map<string, string>());

export function setSessionDir(ctx: ExtensionContext, dir: string | undefined) {
	const id = ctx.sessionManager.getSessionId();
	if (dir) dirs.set(id, dir);
	else dirs.delete(id);
}

/** The directory the session works in: its worktree when the workspace extension made one, else `ctx.cwd`. */
export function sessionDir(ctx: ExtensionContext): string {
	return dirs.get(ctx.sessionManager.getSessionId()) ?? ctx.cwd;
}
