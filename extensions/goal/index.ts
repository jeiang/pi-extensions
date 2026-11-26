import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ENTRY = "goal";
const CONTEXT = "goal-mode-context";
const CONTINUATION = "goal-continuation";
const TOOL = "goal";
/** Plan mode's tool: it blocks the edits a goal needs, so the pair would spin. */
const PLAN_TOOL = "propose";

type Status = "active" | "paused" | "complete";

interface GoalState {
	objective: string;
	status: Status;
	/** Continuations the harness has sent for this goal. */
	turns: number;
	/** The last three lines of the response that stopped the run, so the continuation can answer it. */
	lastStop?: string;
}

function goalPrompt(state: GoalState, continuation: boolean, budget?: string): string {
	const opening = continuation
		? `[GOAL MODE] Continuation ${state.turns}: the previous response did not finish the goal.`
		: "[GOAL MODE] You are working autonomously until the goal is done.";
	return `${opening}
Goal: ${state.objective}

Your response does not end the run: the harness sends the next request when you stop, until you call ${TOOL}({op:"complete"}). The user can still stop you with Esc or /goal.

- Do the next unfinished piece of work now and completely: code, tests, and the checks that prove it. Then the next one. Do not report progress and wait for permission.
- Never end a response with a summary of what you would do next, options, a recommendation, or a "Needs you" section. A response that only reports is wasted; the run continues anyway.
- If you genuinely need the user's decision, call the questionnaire tool: it waits for the answer and you continue afterwards. A question in prose does not stop the run.
- Keep the plan file or todo list current as you go. The goal outlives compaction and a session restart, and that file is what you read next.
${budget ? `- Context: ${budget}. It is never a reason to stop; compaction handles it.` : ""}
${state.lastStop && continuation ? `- Your last response ended with: "${state.lastStop}". That is not a stop: finish it yourself, or ask with the questionnaire tool when only the user can decide.` : ""}
- Call ${TOOL}({op:"complete", summary}) only when every part of the goal is done and checked. Finishing a milestone, writing a report, or running low on context is not the end; compaction handles context.`;
}

/** The last three non-empty lines of the run's final assistant message, for the next continuation to answer. */
function lastLines(ctx: ExtensionContext): string | undefined {
	const entries = ctx.sessionManager.getBranch();
	const last = entries.filter((entry) => entry.type === "message" && entry.message?.role === "assistant").at(-1) as
		| { message?: { content?: unknown } }
		| undefined;
	const content = last?.message?.content;
	const text = Array.isArray(content)
		? content.flatMap((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? [part.text] : [])).join("\n")
		: "";
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.slice(-3);
	return lines.length > 0 ? lines.join(" ").slice(0, 300) : undefined;
}

export default function (pi: ExtensionAPI) {
	let state: GoalState | undefined;

	const setTool = (on: boolean) => {
		const active = pi.getActiveTools().filter((name) => name !== TOOL);
		pi.setActiveTools(on ? [...active, TOOL] : active);
	};

	const showStatus = (ctx: ExtensionContext) => {
		const text = state && (state.status === "active" ? `goal ${state.turns}` : `goal ${state.status}`);
		ctx.ui.setStatus(ENTRY, text || undefined);
	};

	const save = (next: GoalState | undefined, ctx: ExtensionContext) => {
		state = next;
		pi.appendEntry(ENTRY, next ?? null);
		setTool(next?.status === "active");
		showStatus(ctx);
	};

	pi.registerTool({
		name: TOOL,
		label: "Goal",
		description:
			"Read the goal this session is working toward, or finish it once every part is done and checked. Goal mode continues the run after every response until this call.",
		parameters: Type.Object({
			op: Type.String({ enum: ["get", "complete"], description: "get reads the goal; complete ends goal mode." }),
			summary: Type.Optional(
				Type.String({ description: "For complete: what is finished, and where each part of the goal is checked." }),
			),
		}),
		defaultActive: false,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!state) throw new Error("No goal is active. The user starts one with /goal <objective>.");
			if (params.op !== "complete") {
				return {
					content: [
						{
							type: "text",
							text: `Goal: ${state.objective}\nStatus: ${state.status}\nContinuations so far: ${state.turns}`,
						},
					],
					details: {},
				};
			}
			const summary = params.summary?.trim();
			if (!summary) throw new Error("complete needs a summary of what is finished and where it is checked.");
			save({ ...state, status: "complete" }, ctx);
			ctx.ui.notify("Goal complete", "info");
			return { content: [{ type: "text", text: `Goal complete: ${summary}` }], details: { summary }, terminate: true };
		},
	});

	pi.registerCommand(ENTRY, {
		description:
			"Work autonomously until an objective is done: /goal <objective> starts, /goal pauses or resumes, /goal off clears",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (text === "off") {
				if (!state) {
					ctx.ui.notify("No goal to clear.", "info");
					return;
				}
				save(undefined, ctx);
				ctx.ui.notify("Goal off", "info");
				return;
			}
			if (!text) {
				if (!state) {
					ctx.ui.notify("No goal. Start one with /goal <objective>.", "info");
					return;
				}
				if (state.status === "paused") {
					save({ ...state, status: "active" }, ctx);
					ctx.ui.notify(`Goal resumed: ${state.objective}`, "info");
					pi.sendUserMessage("Resume the goal.", ctx.isIdle() ? undefined : { deliverAs: "steer" });
					return;
				}
				if (state.status === "active") {
					save({ ...state, status: "paused" }, ctx);
					ctx.ui.notify(`Goal paused: ${state.objective}. /goal resumes it.`, "info");
					return;
				}
				ctx.ui.notify(`Goal complete: ${state.objective}. /goal off clears it.`, "info");
				return;
			}
			if (pi.getActiveTools().includes(PLAN_TOOL)) {
				ctx.ui.notify("Plan mode is on and blocks the edits a goal needs. Approve the plan first, then /goal.", "warning");
				return;
			}
			save({ objective: text, status: "active", turns: 0 }, ctx);
			ctx.ui.notify(`Goal: ${text}`, "info");
			pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "steer" });
		},
	});

	// The goal stays in view at the start of every run, and after a compaction or a restart.
	pi.on("before_agent_start", (event) => {
		if (state?.status !== "active" || event.messageType !== "user") return;
		return { message: { customType: CONTEXT, content: goalPrompt(state, false), display: false } };
	});

	// Every completed run that has not finished the goal gets one more request, so a response that
	// only reports or offers options cannot end the work.
	pi.on("agent_before_settle", (event, ctx) => {
		if (event.outcome !== "completed" || state?.status !== "active") return;
		// The boundary persists this turn's state itself; appendEntry would land outside the validated proposal.
		const usage = ctx.getContextUsage();
		const budget =
			usage?.tokens != null && usage.contextWindow
				? `${Math.round(usage.tokens / 1000)}k of ${Math.round(usage.contextWindow / 1000)}k used (${Math.round(usage.percent ?? 0)}%)`
				: undefined;
		const next: GoalState = { ...state, turns: state.turns + 1, lastStop: lastLines(ctx) };
		state = next;
		showStatus(ctx);
		return {
			entries: [
				{ type: "custom", customType: ENTRY, data: next },
				{ type: "custom_message", customType: CONTINUATION, content: goalPrompt(next, true, budget), display: false },
			],
			continue: true,
		};
	});

	// Esc stops the run, not the goal: the goal waits for /goal instead of continuing the next prompt.
	pi.on("agent_settled", (event, ctx) => {
		if (!event.aborted || state?.status !== "active") return;
		save({ ...state, status: "paused" }, ctx);
		ctx.ui.notify("Goal paused: Esc stopped the run. /goal resumes it.", "info");
	});

	// A paused or finished goal's instructions would mislead the next run, so they leave the context.
	pi.on("context", (event) => {
		if (state?.status === "active") return;
		const drop = (type: string | undefined) => type === CONTEXT || type === CONTINUATION;
		const messages = event.messages.filter((message) => !drop((message as { customType?: string }).customType));
		if (messages.length !== event.messages.length) return { messages };
	});

	const restore = (event: { reason?: string } | undefined, ctx: ExtensionContext) => {
		const entry = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && e.customType === ENTRY)
			.pop() as { data?: GoalState | null } | undefined;
		const data = entry?.data;
		const goal = data && typeof data.objective === "string" && data.status !== "complete" ? data : undefined;
		// A goal restored by a reload keeps running; a reopened or forked session waits for /goal.
		state = goal && event?.reason && event.reason !== "reload" ? { ...goal, status: "paused" } : goal;
		setTool(state?.status === "active");
		showStatus(ctx);
	};

	pi.on("session_start", (event, ctx) => restore(event, ctx));
	pi.on("session_tree", (_event, ctx) => restore(undefined, ctx));
}
