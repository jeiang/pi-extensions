import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, AssistantMessage, Message, Model, ModelThinkingLevel, Usage } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { LEVELS, parseTarget } from "../chains/index.ts";
import { addUsage } from "../footer/cost.ts";

export interface AdvisorConfig {
	/** `provider/model:level` targets tried in order until one answers. */
	models: string[];
	timeoutMs?: number;
	/** Extra review rules appended to the advisor's instructions. */
	rubric?: string;
}

const LGTM = /^\s*LGTM\b/i;
const MAX_PART = 4000;
const MAX_NITS = 2;
const COLLAPSED_LINES = 3;
// A run that only answered a question needs no second model.
const ACTING_TOOLS: Record<string, true> = { edit: true, write: true, replace: true, substitute: true, shell: true, codemode: true, subagent: true };
const POINT = /^[\s>*\-\d.)]*[`*]*(blocker|concern|nit)[`*]*\s*[:.]/i;

const INSTRUCTIONS = `You review a coding agent's finished run. You see the transcript and cannot act. Silence is the default: answer \`LGTM\` alone unless a point below applies. When the agent asks you a question directly, answer the question instead.

Report a point only when you can name the transcript evidence and what goes wrong for the user if it is ignored:
- \`blocker\`: a claim of done that was not exercised, a wrong or contradicted claim, an explicit instruction breached, an irreversible step without approval, a stub in place of the work.
- \`concern\`: a likely defect or a check too thin for the risk taken.
- \`nit\`: a real but minor point. At most two.

Do not report: wording or style, alternative designs, scope size, backwards compatibility nobody required, requests to ask the user for clarification, errors the agent already saw, or anything you raised before. A part marked \`[…]\` is cut, not absent: never claim a check is missing unless you looked for it in the full transcript.

At most three blockers and concerns, blockers first, one sentence each plus the evidence. Start each point on its own line with its label and a colon, as in \`concern: …\`.`;

const RESTATE = `Handle these points. Then write your final report again in full. The user reads only your last message: it must stand alone and repeat every result, decision, and approval request that still applies. Say in one line which points you skipped and why.`;

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

function clip(text: string): string {
	return text.length > MAX_PART ? `${text.slice(0, MAX_PART / 2)}\n[…]\n${text.slice(-MAX_PART / 2)}` : text;
}

function partsText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type?: string; text?: string; name?: string; arguments?: unknown }) => {
			if (part.type === "text") return part.text ?? "";
			if (part.type === "toolCall") return `[tool call ${part.name}] ${JSON.stringify(part.arguments)}`;
			if (part.type === "image") return "[image]";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

/** Plain-text transcript of agent messages for the advisor. */
export function transcript(messages: readonly AgentMessageLike[]): string {
	return messages
		.flatMap((message) => {
			const text = clip(partsText(message.content));
			if (!text) return [];
			if (message.role === "toolResult") return [`## tool result ${message.toolName ?? ""}${message.isError ? " (error)" : ""}\n${text}`];
			if (message.role === "user" || message.role === "assistant") return [`## ${message.role}\n${text}`];
			if (message.role === "custom") return [`## note\n${text}`];
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
		let enabled = true;
		let available: Model<Api>[] = [];
		let history: Message[] = [];
		let pending: AgentMessageLike[] = [];
		let advisedThisInput = false;
		let acted = false;

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
			enabled = state?.enabled ?? true;
			targets = (state?.models ?? config.models).map(parseTarget);
			setToolActive();
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

		/** Asks the first target that answers. `usage` covers every attempt, failed ones included. */
		const ask = async (ctx: ExtensionContext, question: string, signal?: AbortSignal): Promise<{ answer?: string; usage?: Usage }> => {
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
				if (result.stopReason === "error") continue;
				history = [...history, user, result];
				return { answer: answerText(result), usage };
			}
			return { usage };
		};

		pi.on("input", () => {
			advisedThisInput = false;
			acted = false;
		});

		pi.on("tool_call", (event) => {
			if (ACTING_TOOLS[event.toolName]) acted = true;
		});

		pi.registerMessageRenderer<undefined>("advisor", (message, { expanded }, theme) =>
			// The card shows the points; the instruction that follows them is for the agent.
			card("Advisor", typeof message.content === "string" ? message.content.replace(/^Advisor:\n/, "").replace(`\n\n${RESTATE}`, "") : "", expanded, theme),
		);
		pi.registerEntryRenderer<string>("advisor-nits", (entry, { expanded }, theme) => card("Advisor nits", entry.data ?? "", expanded, theme));

		pi.on("agent_end", (event) => {
			pending.push(...event.messages);
		});

		pi.on("session_compact", () => {
			history = [];
		});

		// The last actionable point of a run: the agent continues in the same run and restates its report.
		pi.on("agent_before_settle", async (event, ctx) => {
			if (!enabled || event.outcome !== "completed" || advisedThisInput) {
				pending = [];
				return;
			}
			if (!acted) return;
			const delta = transcript(pending);
			pending = [];
			if (!delta) return;
			const { answer: advice, usage } = await ask(ctx, `Review this part of the conversation:\n\n${delta}`, ctx.signal).catch((error: Error) => {
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
				const delta = transcript(pending);
				pending = [];
				const question = delta ? `Conversation since your last look:\n\n${delta}\n\nQuestion: ${input.question}` : input.question;
				const { answer, usage } = await ask(ctx, question, signal);
				return { content: [{ type: "text", text: answer ?? "The advisor did not answer (every model failed or timed out)." }], details: undefined, usage };
			},
		});
	};
}

export default function (pi: ExtensionAPI) {
	const file = process.env.PI_ADVISOR_CONFIG ?? join(getAgentDir(), "advisor.json");
	createAdvisor(JSON.parse(readFileSync(file, "utf8")) as AdvisorConfig)(pi);
}
