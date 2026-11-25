import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, AssistantMessage, Message, Model, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm, type ExtensionAPI, type ExtensionContext, getAgentDir, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { LEVELS, parseTarget } from "../chains/index.ts";
import { addUsage } from "../footer/cost.ts";
import { effectsOf } from "../workspace/effects.ts";
import { setReviewer } from "./review.ts";

export interface AdvisorConfig {
	/** `provider/model:level` targets tried in order until one answers. */
	models: string[];
	timeoutMs?: number;
	/** Whether the advisor reviews runs before `/advisor on` or a saved session state says otherwise. Defaults to off. */
	enabled?: boolean;
	/** Extra review rules appended to the advisor's instructions. */
	rubric?: string;
}

const LGTM = /^\s*LGTM\b/i;
const MAX_NITS = 2;
const COLLAPSED_LINES = 3;
const POINT = /^[\s>*\-\d.)]*[`*]*(blocker|concern|nit)[`*]*\s*[:.]/i;

const INSTRUCTIONS = `You review a coding agent's finished run on behalf of its user. You see the agent's instructions and transcript, quoted, and cannot act. Silence is the default: answer \`LGTM\` alone when the agent is on track. When the agent asks you a question directly, answer the question instead.

The agent's instructions and the user's words bind you too: never flag what they allow or what the user accepted.

Report a point only on a concrete technical risk or a failure the transcript shows, one the agent would fix if it saw it. Name the evidence and what goes wrong for the user if it is ignored. Generic uncertainty or vague unease: stay silent.
- \`blocker\`: a claim of done or verified that the transcript contradicts or never exercised, an explicit instruction breached, an irreversible step without approval, a stub in place of the work, yielding before a stated condition such as green CI is met.
- \`concern\`: a likely defect, or a guess where a cheap check or a primary source was at hand.
- \`nit\`: a real but minor point, such as a simpler approach. At most two.

Never report: wording or style, scope or size of the change, backwards compatibility nobody required, requests to ask the user for clarification or confirm scope, errors the agent already saw, reasoning the agent already did, or anything you raised before unless new evidence makes it a blocker. Never second-guess a decision the agent understood and committed to unless you are certain. Cite only what the transcript shows: a tool result that says it was truncated is an excerpt, not the whole output.

At most three blockers and concerns, blockers first, one sentence each plus the evidence. Start each point on its own line with its label and a colon, as in \`concern: …\`.`;

const RESTATE = `Weigh these points: act on the ones the evidence supports, and reject the others with their evidence in one line each. Then write your final report again in full. The user reads only your last message: it must stand alone and repeat every result, decision, and approval request that still applies.`;

/** Splits advice into the points that restart the agent and the nits that are only shown. Unlabeled advice restarts it. */
export function parseAdvice(advice: string): { serious: string; nits: string } {
	const points: { nit: boolean; lines: string[] }[] = [];
	for (const line of advice.trim().split("\n")) {
		const kind = line.match(POINT)?.[1]?.toLowerCase();
		if (kind) points.push({ nit: kind === "nit", lines: [line] });
		else points.at(-1)?.lines.push(line);
	}
	if (points.length === 0) return { serious: advice.trim(), nits: "" };
	const join = (nit: boolean, limit?: number) =>
		points
			.filter((point) => point.nit === nit)
			.slice(0, limit)
			.map((point) => point.lines.join("\n").trim())
			.join("\n");
	return { serious: join(false), nits: join(true, MAX_NITS) };
}

function card(title: string, body: string, expanded: boolean, theme: Theme) {
	const lines = body.split("\n");
	const shown = expanded ? lines : lines.slice(0, COLLAPSED_LINES);
	const more = lines.length - shown.length;
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text([theme.fg("accent", title), ...shown, ...(more > 0 ? [theme.fg("dim", `… ${more} more lines`)] : [])].join("\n"), 0, 0));
	return box;
}

type AgentMessageLike = { role: string; content?: unknown; toolName?: string; isError?: boolean };

function partsText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown }) => {
			if (part.type === "text") return part.text ?? "";
			if (part.type === "thinking") return part.thinking ? `[thinking] ${part.thinking}` : "";
			if (part.type === "toolCall") return `[tool call ${part.name}] ${JSON.stringify(part.arguments)}`;
			if (part.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

/** Plain-text transcript of model messages for the advisor. */
export function transcript(messages: readonly AgentMessageLike[]): string {
	return messages
		.flatMap((message) => {
			const text = partsText(message.content);
			if (!text) return [];
			if (message.role === "toolResult") return [`## tool result ${message.toolName ?? ""}${message.isError ? " (error)" : ""}\n${text}`];
			if (message.role === "user" || message.role === "assistant") return [`## ${message.role}\n${text}`];
			return [];
		})
		.join("\n\n");
}

function answerText(message: AssistantMessage): string {
	return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n").trim();
}

type Target = ReturnType<typeof parseTarget>;

const STATE = "advisor-state";

interface AdvisorState {
	enabled: boolean;
	models: string[];
}

const format = (target: Target) => `${target.provider}/${target.id}:${target.thinkingLevel}`;

export function createAdvisor(config: AdvisorConfig) {
	const timeoutMs = config.timeoutMs ?? 90_000;
	const systemPrompt = config.rubric ? `${INSTRUCTIONS}\n\nRubric (a breach is a concern):\n${config.rubric}` : INSTRUCTIONS;

	return (pi: ExtensionAPI) => {
		let targets = config.models.map(parseTarget);
		const enabledByDefault = config.enabled ?? false;
		let enabled = enabledByDefault;
		let available: Model<Api>[] = [];
		let history: Message[] = [];
		// What `history` already covers; a mismatch (compaction, branch change, new prompt, restart) starts it over.
		let seen: { prompt: string; count: number; last?: number } | undefined;
		let advisedThisInput = false;
		let acted = false;
		// propose has the plan reviewed; reviewing the run again would only delay the user's review.
		let proposed = false;

		const setToolActive = () => {
			const others = pi.getActiveTools().filter((name) => name !== "advise");
			pi.setActiveTools(enabled ? [...others, "advise"] : others);
		};
		const status = () => `Advisor ${enabled ? "on" : "off"}: ${targets.map(format).join(" → ")}`;

		// pi restores the tool loadout per branch, so the saved state is re-read on every branch change.
		const restore = (_event: unknown, ctx: ExtensionContext) => {
			available = ctx.modelRegistry.getAvailable();
			const saved = ctx.sessionManager
				.getBranch()
				.filter((entry) => entry.type === "custom" && entry.customType === STATE)
				.at(-1);
			const state = saved?.type === "custom" ? (saved.data as AdvisorState | undefined) : undefined;
			enabled = state?.enabled ?? enabledByDefault;
			targets = (state?.models ?? config.models).map(parseTarget);
			setToolActive();
			setReviewer(ctx, (ctx, request, signal) => {
				if (!enabled) return undefined;
				return ask(ctx, request, signal).then(({ answer, usage }) =>
					answer === undefined ? { answered: false, serious: "", nits: "", usage } : LGTM.test(answer) ? { answered: true, serious: "", nits: "", usage } : { answered: true, ...parseAdvice(answer), usage },
				);
			});
		};
		pi.on("session_start", restore);
		pi.on("session_tree", restore);

		pi.registerCommand("advisor", {
			description: "Show or change the advisor: /advisor [on|off|<level>|<provider/model[:level]>]",
			getArgumentCompletions: (prefix) => {
				const colon = prefix.lastIndexOf(":");
				const values =
					colon > prefix.indexOf("/") && prefix.includes("/")
						? Object.keys(LEVELS).map((level) => `${prefix.slice(0, colon + 1)}${level}`)
						: ["on", "off", ...Object.keys(LEVELS), ...available.map((model) => `${model.provider}/${model.id}`)];
				return values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			},
			handler: async (args, ctx) => {
				const arg = args.trim();
				if (arg === "on" || arg === "off") {
					enabled = arg === "on";
					setToolActive();
				} else if (Object.hasOwn(LEVELS, arg)) {
					const [first, ...rest] = targets;
					if (first) targets = [{ ...first, thinkingLevel: arg as ModelThinkingLevel }, ...rest];
				} else if (arg) {
					let target: Target;
					try {
						target = parseTarget(arg);
					} catch {
						return ctx.ui.notify(`Expected on, off, a reasoning level, or provider/model[:level], got "${arg}"`, "error");
					}
					if (!ctx.modelRegistry.find(target.provider, target.id)) return ctx.ui.notify(`Unknown model ${target.provider}/${target.id}`, "error");
					// Without a level suffix the new model keeps the current primary's level.
					if (!Object.hasOwn(LEVELS, arg.slice(arg.lastIndexOf(":") + 1)) && targets[0]) target.thinkingLevel = targets[0].thinkingLevel;
					targets = [target, ...targets.filter((t) => t.provider !== target.provider || t.id !== target.id)];
				}
				if (arg) pi.appendEntry<AdvisorState>(STATE, { enabled, models: targets.map(format) });
				ctx.ui.notify(status(), "info");
			},
		});

		/**
		 * Asks the first target that answers, sending the agent's system prompt and transcript the first time and only
		 * what is new afterwards. `usage` covers every attempt, failed ones included.
		 */
		const ask = async (ctx: ExtensionContext, request: string, signal?: AbortSignal): Promise<{ answer?: string; usage?: Usage }> => {
			const prompt = ctx.getSystemPrompt();
			const context = convertToLlm(buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages);
			const fresh = !seen || seen.prompt !== prompt || context.length < seen.count || context[seen.count - 1]?.timestamp !== seen.last;
			if (fresh) history = [];
			const delta = transcript(fresh ? context : context.slice(seen?.count));
			const question = [
				fresh ? `The agent's instructions:\n\n<instructions>\n${prompt}\n</instructions>` : "",
				delta ? `${fresh ? "The transcript" : "The transcript since your last look"}:\n\n<transcript>\n${delta}\n</transcript>` : "",
				request,
			]
				.filter(Boolean)
				.join("\n\n");
			const user: Message = { role: "user", content: question, timestamp: Date.now() };
			const timeout = AbortSignal.timeout(timeoutMs);
			const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
			let usage: Usage | undefined;
			for (const target of targets) {
				const model = ctx.modelRegistry.find(target.provider, target.id);
				if (!model) continue;
				const result = await ctx.modelRegistry
					.streamSimple(
						model,
						{ systemPrompt, messages: [...history, user] },
						{ reasoning: target.thinkingLevel === "off" ? undefined : target.thinkingLevel, signal: combined },
					)
					.result();
				usage = addUsage(usage, result.usage);
				if (combined.aborted) return { usage };
				// An empty answer is no answer: counting it as one would report a clean review of a plan nobody read.
				if (result.stopReason === "error" || !answerText(result).trim()) continue;
				history = [...history, user, result];
				seen = { prompt, count: context.length, last: context.at(-1)?.timestamp };
				return { answer: answerText(result), usage };
			}
			return { usage };
		};

		pi.on("input", () => {
			advisedThisInput = false;
			acted = false;
			proposed = false;
		});

		pi.on("tool_call", (event, ctx) => {
			// A run that only answered a question needs no second model.
			if (effectsOf(event.toolName, event.input as Record<string, unknown>, ctx.cwd).kind !== "read") acted = true;
			if (event.toolName === "propose") proposed = true;
		});

		pi.registerMessageRenderer<undefined>("advisor", (message, { expanded }, theme) =>
			// The card shows the points; the instruction that follows them is for the agent.
			card("Advisor", typeof message.content === "string" ? message.content.replace(/^Advisor:\n/, "").replace(`\n\n${RESTATE}`, "") : "", expanded, theme),
		);
		pi.registerEntryRenderer<string>("advisor-nits", (entry, { expanded }, theme) => card("Advisor nits", entry.data ?? "", expanded, theme));

		// The last actionable point of a run: the agent continues in the same run and restates its report.
		pi.on("agent_before_settle", async (event, ctx) => {
			if (!enabled || event.outcome !== "completed" || advisedThisInput || !acted || proposed) return;
			const { answer: advice, usage } = await ask(ctx, "Review the agent's latest run.", ctx.signal).catch((error: Error) => {
				if (ctx.hasUI) ctx.ui.notify(`Advisor failed: ${error.message}`, "warning");
				return { answer: undefined, usage: undefined };
			});
			const entries = [...event.entries];
			if (usage) entries.push({ type: "custom", customType: "advisor-usage", data: usage });
			if (!advice || LGTM.test(advice)) return { entries };
			const { serious, nits } = parseAdvice(advice);
			if (nits) entries.push({ type: "custom", customType: "advisor-nits", data: nits });
			if (!serious) return { entries };
			advisedThisInput = true;
			entries.push({ type: "custom_message", customType: "advisor", content: `Advisor:\n${serious}\n\n${RESTATE}`, display: true });
			return { entries, continue: true };
		});

		const params = Type.Object({ question: Type.String({ description: "What you want a second opinion on, with the context it needs." }) });
		pi.registerTool({
			name: "advise",
			label: "Advise",
			description:
				"Ask a stronger reviewer model for a second opinion on a plan, a diagnosis, or a risky step. It sees the conversation so far and has no tools.",
			promptSnippet: "Ask the advisor model for a second opinion",
			parameters: params,
			exposure: "model-only",
			async execute(_id, input: Static<typeof params>, signal, _onUpdate, ctx) {
				const { answer, usage } = await ask(ctx, `Question: ${input.question}`, signal);
				return { content: [{ type: "text", text: answer ?? "The advisor did not answer (every model failed or timed out)." }], details: undefined, usage };
			},
		});
	};
}

export default function (pi: ExtensionAPI) {
	const file = process.env.PI_ADVISOR_CONFIG ?? join(getAgentDir(), "advisor.json");
	createAdvisor(JSON.parse(readFileSync(file, "utf8")) as AdvisorConfig)(pi);
}
