import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ENTRY = "checkpoint";

export interface Checkpoint {
	/** Five lines: done, next, blocked, where, checks. */
	state: string;
	/** ISO timestamp of the write. */
	at: string;
}

/** The newest checkpoint on the active branch, or undefined. */
export function lastCheckpoint(manager: { getBranch(): { type: string; customType?: string; data?: unknown }[] }): Checkpoint | undefined {
	const entry = manager
		.getBranch()
		.filter((candidate) => candidate.type === "custom" && candidate.customType === ENTRY)
		.at(-1);
	const data = entry?.data as Checkpoint | undefined;
	return typeof data?.state === "string" && data.state.trim() ? data : undefined;
}

/** The checkout's branch and changed paths; empty outside a repository. */
export function gitSummary(cwd: string): string {
	const git = (args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	try {
		const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
		const dirty = git(["status", "--short"]).trim();
		return dirty ? `${branch}\n${dirty}` : `${branch} (clean)`;
	} catch {
		return "";
	}
}

/** What `/status` shows: the checkpoint, then the checkout, or a line saying what is missing. */
export function formatStatus(checkpoint: Checkpoint | undefined, git: string): string {
	const parts = [
		checkpoint ? `Checkpoint (${checkpoint.at.slice(0, 16).replace("T", " ")}):\n${checkpoint.state.trim()}` : "No checkpoint yet. The checkpoint tool records done, next, blocked, where, and checks.",
		git ? `Checkout:\n${git}` : "",
	];
	return parts.filter(Boolean).join("\n\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "checkpoint",
		label: "Checkpoint",
		description:
			"Record the session's state in five lines: what is done, what is next, what is blocked, where the work lives (branch and worktree), and which checks passed. Call it at a phase boundary. /status prints it, and a resumed session starts with it.",
		promptSnippet: "Record the session state for /status and for a resumed session",
		parameters: Type.Object({
			state: Type.String({
				description: "Five lines: done, next, blocked, where (branch and worktree), checks (what passed, failed, or could not run).",
			}),
		}),
		async execute(_id, input: { state: string }, _signal, _onUpdate, ctx) {
			const checkpoint: Checkpoint = { state: input.state.trim(), at: new Date().toISOString() };
			pi.appendEntry(ENTRY, checkpoint);
			ctx.ui.setStatus(ENTRY, checkpoint.state.split("\n")[0]?.slice(0, 48));
			return { content: [{ type: "text" as const, text: "Recorded. /status shows it; a resumed session starts with it." }], details: undefined };
		},
	});

	pi.registerCommand("status", {
		description: "Show the last checkpoint and the checkout's branch and changes.",
		handler: async (_args, ctx) => {
			ctx.ui.notify(formatStatus(lastCheckpoint(ctx.sessionManager), gitSummary(ctx.cwd)), "info");
		},
	});

	// A resumed or forked session opens with the state the last run left, instead of re-deriving it.
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "resume" && event.reason !== "fork") return;
		const checkpoint = lastCheckpoint(ctx.sessionManager);
		if (!checkpoint) return;
		pi.sendMessage({ customType: ENTRY, content: `[resumed session] Last checkpoint:\n${checkpoint.state.trim()}`, display: true }, {});
	});
}
