import { resolve } from "node:path";
import { previewPaths } from "../lsp/edits.ts";
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
	/** A call that may act and cannot be classified: run, codemode, a subagent. */
	| { kind: "opaque" };

/** The github ops that change something on GitHub. */
const GITHUB_WRITES = new Set(["pr_create", "pr_merge", "pr_comment", "pr_close", "pr_edit", "workflow_run"]);

const READ: Effect = { kind: "read" };
const MUTATE: Effect = { kind: "mutate" };
const OPAQUE: Effect = { kind: "opaque" };

/** Tools that never change the repository; `nix` builds in the store, not in the tree. */
const READ_ONLY = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"read_text",
	"todo",
	"questionnaire",
	"sleep",
	"advise",
	"papercut",
	"nix",
	"propose",
]);

const named = (input: Record<string, unknown>): string[] =>
	Array.isArray(input.paths) ? input.paths.map(String) : typeof input.path === "string" ? [input.path] : [];

export function effectsOf(tool: string, input: Record<string, unknown>, cwd: string): Effect {
	// flake_update rewrites the flake's lock file; the other nix actions build in the store, not in the tree.
	if (tool === "nix" && input.action === "flake_update") {
		const flake = typeof input.flake === "string" && !input.flake.includes(":") ? resolve(cwd, input.flake) : cwd;
		return { kind: "write", paths: [resolve(flake, "flake.lock")] };
	}
	if (READ_ONLY.has(tool)) return READ;
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
		case "lsp": {
			// Only apply writes; its preview names every file it touches.
			if (!input.apply) return READ;
			const paths = typeof input.token === "string" ? previewPaths(input.token) : undefined;
			return paths ? { kind: "write", paths } : OPAQUE;
		}
		case "github":
			return typeof input.op === "string" && GITHUB_WRITES.has(input.op) ? MUTATE : READ;
		case "worktree":
			return input.action === "list" ? READ : MUTATE;
		case "job":
			// Killing or feeding a job acts; looking at one does not.
			return input.action === "kill" || input.action === "write" ? OPAQUE : READ;
		case "transfer": {
			if (input.direction !== "download" || typeof input.local !== "string") return OPAQUE;
			return { kind: "write", paths: [resolve(cwd, input.local.replace(/^@/, ""))] };
		}
		case "run":
		case "codemode":
		case "subagent":
			return OPAQUE;
	}
	const paths = named(input);
	return paths.length > 0 ? { kind: "write", paths: paths.map((path) => resolve(cwd, path.replace(/^@/, ""))) } : OPAQUE;
}
