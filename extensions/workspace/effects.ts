import { resolve } from "node:path";
import { patchTargets } from "./hashline.ts";

/**
 * What a tool call does to the working tree, in the four shapes its callers need to tell apart.
 * The worktree guard reads `write` paths, plan mode blocks `write` outside the plan and `mutate`,
 * and the advisor reviews a run that did anything but read. An unrecognized tool that names a path
 * is a write, so a new file tool cannot slip past the guard.
 */
export type Effect =
	| { kind: "read" }
	/** A file write whose targets are known, resolved against `cwd`. */
	| { kind: "write"; paths: string[] }
	/** A call that changes something outside the filesystem: a pull request, a worktree, a deploy. */
	| { kind: "mutate" }
	/** A call that may act and cannot be classified: shell, codemode, ssh, a subagent. */
	| { kind: "opaque" };

const READ: Effect = { kind: "read" };
const MUTATE: Effect = { kind: "mutate" };
const OPAQUE: Effect = { kind: "opaque" };

/** Tools that never change the repository; `nix` builds in the store, not in the tree. */
const READ_ONLY = new Set(["read", "grep", "find", "ls", "read_text", "todo", "questionnaire", "sleep", "advise", "papercut", "nix", "propose"]);

const named = (input: Record<string, unknown>): string[] =>
	Array.isArray(input.paths) ? input.paths.map(String) : typeof input.path === "string" ? [input.path] : [];

export function effectsOf(tool: string, input: Record<string, unknown>, cwd: string): Effect {
	if (READ_ONLY.has(tool)) return READ;
	// lsp_apply writes every file a workspace edit names, which the call does not list.
	if (tool.startsWith("lsp_")) return tool === "lsp_apply" ? OPAQUE : READ;
	switch (tool) {
		case "edit":
			// The workspace's hashline edit names its files inside the patch; pi's own edit names one path.
			if (typeof input.input !== "string") return { kind: "write", paths: named(input).map((absolute) => resolve(cwd, absolute.replace(/^@/, ""))) };
			return { kind: "write", paths: patchTargets(cwd, "hashline", input) };
		case "replace":
		case "write":
			return { kind: "write", paths: patchTargets(cwd, "replace", input) };
		case "substitute": {
			// Without apply it previews, which writes nothing.
			if (!input.apply) return READ;
			const paths = named(input);
			return { kind: "write", paths: (paths.length > 0 ? paths : ["."]).map((path) => resolve(cwd, path.replace(/^@/, ""))) };
		}
		case "github":
			return input.op === "pr_create" || input.op === "pr_merge" ? MUTATE : READ;
		case "worktree":
			return input.action === "list" ? READ : MUTATE;
		case "shell":
		case "codemode":
		case "ssh":
		case "subagent":
			return OPAQUE;
	}
	const paths = named(input);
	return paths.length > 0 ? { kind: "write", paths: paths.map((path) => resolve(cwd, path.replace(/^@/, ""))) } : OPAQUE;
}
