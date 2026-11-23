// Wire formats of Anthropic and Codex server-side compaction: request shaping, response capture, replay.
import type { Api, Model, Usage } from "@earendil-works/pi-ai";

type Json = Record<string, unknown>;

export type NativeApi = "anthropic-messages" | "openai-codex-responses";

/** A provider checkpoint, replayed only to the model that produced it. */
export type Checkpoint =
	| { api: "anthropic-messages"; model: string; block: Json; fileContext: string }
	| { api: "openai-codex-responses"; model: string; item: Json };

/** `CompactionEntry.details` written by this extension. */
export interface Details {
	readFiles: string[];
	modifiedFiles: string[];
	checkpoint: Checkpoint;
}

export const COMPACTION_BETA = "compact-2026-09-04";

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** The compaction API of a model, if its provider supports server-side compaction. */
export function nativeApi(model: Model<Api>): NativeApi | undefined {
	if (model.api === "anthropic-messages" && model.provider === "anthropic") {
		return new URL(model.baseUrl).hostname === "api.anthropic.com" ? "anthropic-messages" : undefined;
	}
	return model.api === "openai-codex-responses" && model.provider === "openai-codex" ? "openai-codex-responses" : undefined;
}

/** Reads this extension's details from a session file entry, which is untrusted input. */
export function readDetails(details: unknown): Details | undefined {
	if (!isRecord(details) || !isRecord(details.checkpoint)) return undefined;
	const { checkpoint, readFiles, modifiedFiles } = details;
	if (!Array.isArray(readFiles) || !Array.isArray(modifiedFiles) || typeof checkpoint.model !== "string") return undefined;
	const valid =
		(checkpoint.api === "anthropic-messages" &&
			isRecord(checkpoint.block) &&
			typeof checkpoint.block.content === "string" &&
			typeof checkpoint.fileContext === "string") ||
		(checkpoint.api === "openai-codex-responses" &&
			isRecord(checkpoint.item) &&
			typeof checkpoint.item.encrypted_content === "string");
	// SAFETY: the fields Details declares were checked above.
	return valid ? (details as unknown as Details) : undefined;
}

const textOf = (content: unknown): string | undefined =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("")
			: undefined;

const withBeta = (betas: unknown): string[] => [
	...new Set([...(Array.isArray(betas) ? betas.filter((beta) => typeof beta === "string") : []), COMPACTION_BETA]),
];

/**
 * Puts the checkpoint in place of the summary message whose text is `marker`, when the payload is
 * for the checkpoint's model and API. Returns undefined to leave the payload unchanged.
 */
export function replay(payload: unknown, checkpoint: Checkpoint, marker: string): Json | undefined {
	if (!isRecord(payload) || payload.model !== checkpoint.model) return undefined;
	if (checkpoint.api === "anthropic-messages" && Array.isArray(payload.messages)) {
		const index = payload.messages.findIndex(
			(message) => isRecord(message) && message.role === "user" && textOf(message.content) === marker,
		);
		if (index < 0) return undefined;
		const messages = [...payload.messages];
		messages.splice(index, 1, { role: "assistant", content: [checkpoint.block] });
		if (checkpoint.fileContext) messages.splice(index + 1, 0, { role: "user", content: checkpoint.fileContext });
		return { ...payload, messages, betas: withBeta(payload.betas) };
	}
	if (checkpoint.api === "openai-codex-responses" && Array.isArray(payload.input)) {
		const index = payload.input.findIndex(
			(item) => isRecord(item) && item.role === "user" && textOf(item.content) === marker,
		);
		if (index < 0) return undefined;
		// Codex keeps user context in front of its checkpoint; the summary carries it here.
		const input = [...payload.input];
		input.splice(index + 1, 0, checkpoint.item);
		return { ...payload, input };
	}
	return undefined;
}

/** Turns an ordinary request into a compaction request. */
export function compactionRequest(api: NativeApi, payload: unknown, instructions: string | undefined): Json | undefined {
	if (!isRecord(payload)) return undefined;
	if (api === "anthropic-messages") {
		return {
			...payload,
			compaction: { type: "summarize", ...(instructions ? { instructions } : {}) },
			betas: withBeta(payload.betas),
		};
	}
	const input = Array.isArray(payload.input) ? payload.input : [];
	return {
		...payload,
		input: [
			...input,
			...(instructions ? [{ role: "developer", content: instructions }] : []),
			{ type: "compaction_trigger" },
		],
	};
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Collects the compaction from raw provider stream events, which are untrusted input. */
export function collector(api: NativeApi) {
	let block: Json | undefined;
	let blockIndex: unknown;
	let blockDone = false;
	let invalid = false;
	let stop: unknown;
	const items: Json[] = [];
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

	const observeAnthropic = (event: Json) => {
		if (event.type === "content_block_start" && isRecord(event.content_block)) {
			if (event.content_block.type !== "compaction") return;
			if (block) invalid = true;
			block = { ...event.content_block };
			blockIndex = event.index;
		} else if (event.type === "content_block_delta" && block && event.index === blockIndex && isRecord(event.delta)) {
			// Deltas carry final values, not fragments; encrypted_content is beta-gated and may be absent.
			if (event.delta.type === "compaction_delta") {
				block.content = event.delta.content;
				if ("encrypted_content" in event.delta) block.encrypted_content = event.delta.encrypted_content;
			} else if (event.delta.type === "signature_delta") {
				block.signature = event.delta.signature;
			}
		} else if (event.type === "content_block_stop" && block && event.index === blockIndex) {
			blockDone = true;
		} else if (event.type === "message_delta") {
			if (isRecord(event.delta)) stop = event.delta.stop_reason;
			// Compaction tokens are reported per iteration, outside the top-level totals.
			const iterations = isRecord(event.usage) && Array.isArray(event.usage.iterations) ? event.usage.iterations : [];
			for (const iteration of iterations) {
				if (!isRecord(iteration) || iteration.type !== "compaction") continue;
				usage.input += Number(iteration.input_tokens) || 0;
				usage.output += Number(iteration.output_tokens) || 0;
				usage.cacheRead += Number(iteration.cache_read_input_tokens) || 0;
				usage.cacheWrite += Number(iteration.cache_creation_input_tokens) || 0;
			}
		}
	};

	const observeCodex = (event: Json) => {
		if (event.type === "response.output_item.done" && isRecord(event.item) && event.item.type === "compaction") {
			items.push(event.item);
		} else if (typeof event.type === "string" && /^response\.(completed|done|incomplete|failed)$/.test(event.type)) {
			stop = isRecord(event.response) ? event.response.status : undefined;
		}
	};

	return {
		observe(event: unknown) {
			if (isRecord(event)) (api === "anthropic-messages" ? observeAnthropic : observeCodex)(event);
		},
		/** The complete checkpoint, or the reason there is none. */
		result(model: string): { checkpoint: Checkpoint; summary?: string; usage?: Usage } | { error: string } {
			if (api === "anthropic-messages") {
				if (invalid || !block || !blockDone || stop !== "compaction") return { error: "incomplete compaction response" };
				if (typeof block.content !== "string" || !block.content.trim()) return { error: "empty compaction summary" };
				const total = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
				return {
					checkpoint: { api, model, block, fileContext: "" },
					summary: block.content,
					usage: { ...ZERO_USAGE, ...usage, totalTokens: total },
				};
			}
			const [item] = items;
			if (stop !== "completed" || items.length !== 1 || !item || typeof item.encrypted_content !== "string" || !item.encrypted_content) {
				return { error: "incomplete compaction response" };
			}
			return { checkpoint: { api, model, item } };
		},
	};
}

/** Sum of two usages. */
export function addUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: {
			input: a.cost.input + b.cost.input,
			output: a.cost.output + b.cost.output,
			cacheRead: a.cost.cacheRead + b.cost.cacheRead,
			cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
			total: a.cost.total + b.cost.total,
		},
	};
}

/** File lists in pi's summary format. */
export function formatFiles(readFiles: string[], modifiedFiles: string[]): string {
	const sections = [
		readFiles.length > 0 ? `<read-files>\n${readFiles.join("\n")}\n</read-files>` : "",
		modifiedFiles.length > 0 ? `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>` : "",
	].filter(Boolean);
	return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}
