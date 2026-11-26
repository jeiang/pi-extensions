import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { effectsOf } from "../workspace/effects.ts";

const ENTRY = "runlog";

interface Entry {
	type: string;
	message?: { role?: string; content?: unknown; toolCallId?: string };
}

interface Call {
	name: string;
	input: Record<string, unknown>;
	id: string;
}

export interface Unanswered extends Call {
	/** What re-issuing the call would do, as the guards and plan mode already classify it. */
	effect: "read" | "write" | "mutate" | "opaque";
}

const isToolCall = (part: unknown): part is { type: string; id?: string; name?: string; input?: unknown; arguments?: unknown } =>
	Boolean(part && typeof part === "object" && "type" in part && (part.type === "toolCall" || part.type === "tool-call" || part.type === "tool_use"));

/** Calls whose result never landed: the run stopped between the request and the result. */
export function unanswered(entries: Entry[], cwd: string): Unanswered[] {
	const open = new Map<string, Call>();
	for (const entry of entries) {
		const message = entry.type === "message" ? entry.message : undefined;
		if (!message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (!isToolCall(part) || typeof part.id !== "string") continue;
				open.set(part.id, {
					id: part.id,
					name: String(part.name ?? "?"),
					input: (part.input ?? part.arguments ?? {}) as Record<string, unknown>,
				});
			}
		} else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			open.delete(message.toolCallId);
		}
	}
	return [...open.values()].map((call) => ({ ...call, effect: effectsOf(call.name, call.input, cwd).kind }));
}

const SAFE = "re-issue it: it changes nothing";
const CHECK = "check the file or the remote state before you re-issue it";

/** The message a resumed run opens with, or undefined when nothing was left in flight. */
export function resumeNotice(calls: Unanswered[]): string | undefined {
	if (calls.length === 0) return undefined;
	const shown = calls.slice(-3).map((call) => {
		const args = JSON.stringify(call.input).slice(0, 300);
		return `- ${call.name} ${args} (${call.effect === "read" ? SAFE : CHECK})`;
	});
	return `[resumed session] The previous run stopped before ${calls.length === 1 ? "this call" : "these calls"} returned:\n${shown.join("\n")}\nContinue from there; do not restart work whose result you can already see.`;
}

export default function (pi: ExtensionAPI) {
	// The transcript already records every call and result; this reads it instead of writing a second log.
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "resume" && event.reason !== "fork") return;
		const calls = unanswered(ctx.sessionManager.getBranch() as Entry[], ctx.cwd);
		const notice = resumeNotice(calls);
		if (!notice) return;
		pi.appendEntry(ENTRY, { calls: calls.map(({ name, id, effect }) => ({ name, id, effect })) });
		pi.sendMessage({ customType: ENTRY, content: notice, display: true }, {});
	});
}
