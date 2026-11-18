import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { parseTarget } from "../chains/index.ts";

export interface AdvisorConfig {
	/** `provider/model:level` targets tried in order until one answers. */
	models: string[];
	timeoutMs?: number;
	/** Extra review rules appended to the advisor's instructions. */
	rubric?: string;
}

const LGTM = /^\s*LGTM\b/i;
const MAX_PART = 4000;

const INSTRUCTIONS = `You advise a coding agent. You see its conversation as a transcript, one review at a time, and you never act yourself.
Review the newest part for: wrong or unverified claims, a misread request, risky or irreversible steps without approval, skipped verification, scope creep, and code that breaks the rubric below.
Answer "LGTM" alone when nothing needs attention. Otherwise give at most five short, concrete points the agent can act on, most important first. No praise, no summary.`;

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

export function createAdvisor(config: AdvisorConfig) {
	const targets = config.models.map(parseTarget);
	const timeoutMs = config.timeoutMs ?? 90_000;
	const systemPrompt = config.rubric ? `${INSTRUCTIONS}\n\nRubric:\n${config.rubric}` : INSTRUCTIONS;

	return (pi: ExtensionAPI) => {
		let history: Message[] = [];
		let pending: AgentMessageLike[] = [];
		let advisedThisInput = false;
		let running: AbortController | undefined;

		const ask = async (ctx: ExtensionContext, question: string, signal?: AbortSignal): Promise<string | undefined> => {
			const user: Message = { role: "user", content: question, timestamp: Date.now() };
			const timeout = AbortSignal.timeout(timeoutMs);
			const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
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
				if (combined.aborted) return undefined;
				if (result.stopReason === "error") continue;
				history = [...history, user, result];
				return answerText(result);
			}
			return undefined;
		};

		pi.on("input", () => {
			advisedThisInput = false;
		});

		pi.on("agent_end", (event) => {
			pending.push(...event.messages);
		});

		pi.on("session_compact", () => {
			history = [];
		});

		pi.on("agent_settled", async (event, ctx) => {
			if (event.aborted || advisedThisInput || pending.length === 0) {
				pending = [];
				return;
			}
			const delta = transcript(pending);
			pending = [];
			if (!delta) return;
			running?.abort();
			running = new AbortController();
			const advice = await ask(ctx, `Review this part of the conversation:\n\n${delta}`, running.signal).catch((error: Error) => {
				if (ctx.hasUI) ctx.ui.notify(`Advisor failed: ${error.message}`, "warning");
				return undefined;
			});
			if (!advice || LGTM.test(advice)) return;
			advisedThisInput = true;
			pi.sendMessage({ customType: "advisor", content: `Advisor:\n${advice}`, display: true }, { triggerTurn: true, deliverAs: "followUp" });
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
				const answer = await ask(ctx, question, signal);
				return { content: [{ type: "text", text: answer ?? "The advisor did not answer (every model failed or timed out)." }], details: undefined };
			},
		});
	};
}

export default function (pi: ExtensionAPI) {
	const file = process.env.PI_ADVISOR_CONFIG ?? join(getAgentDir(), "advisor.json");
	createAdvisor(JSON.parse(readFileSync(file, "utf8")) as AdvisorConfig)(pi);
}
