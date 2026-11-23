// Server-side compaction for Anthropic and Codex: saves the provider checkpoint and replays it to the same model.
import type { Api, Message, Model } from "@earendil-works/pi-ai";
import {
	compact,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	addUsage,
	type Checkpoint,
	collector,
	compactionRequest,
	type Details,
	formatFiles,
	nativeApi,
	readDetails,
	replay,
} from "./protocol.ts";

type Preparation = SessionBeforeCompactEvent["preparation"];

/** The user message pi builds from a compaction summary, as sent to providers. */
function summaryMessage(summary: string): Message {
	const [message] = convertToLlm([{ role: "compactionSummary", summary, tokensBefore: 0, timestamp: 0 }]);
	if (!message) throw new Error("pi did not convert the compaction summary");
	return message;
}

function summaryText(summary: string): string {
	const { content } = summaryMessage(summary);
	return typeof content === "string" ? content : content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** The checkpoint of the compaction now in context, if this extension wrote it. */
function latestCheckpoint(entries: SessionEntry[]): { summary: string; details: Details } | undefined {
	const entry = entries.findLast((candidate) => candidate.type === "compaction");
	if (entry?.type !== "compaction" || !entry.fromHook) return undefined;
	const details = readDetails(entry.details);
	return details && { summary: entry.summary, details };
}

/** The selected model, or the one that answered last when a virtual model such as a chain is selected. */
function compactionModel(ctx: ExtensionContext, entries: SessionEntry[]): Model<Api> | undefined {
	if (ctx.model && nativeApi(ctx.model)) return ctx.model;
	const last = entries.findLast(
		(entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason !== "error",
	);
	if (last?.type !== "message" || last.message.role !== "assistant") return undefined;
	const model = ctx.modelRegistry.find(last.message.provider, last.message.model);
	return model && nativeApi(model) ? model : undefined;
}

function fileLists(preparation: Preparation): { readFiles: string[]; modifiedFiles: string[] } {
	const { read, edited, written } = preparation.fileOps;
	const modified = new Set([...edited, ...written]);
	return { readFiles: [...read].filter((file) => !modified.has(file)).sort(), modifiedFiles: [...modified].sort() };
}

export default function (pi: ExtensionAPI) {
	async function serverCompaction(
		ctx: ExtensionContext,
		model: Model<Api>,
		preparation: Preparation,
		previous: { summary: string; details: Details } | undefined,
		customInstructions: string | undefined,
		signal: AbortSignal,
	) {
		const api = nativeApi(model);
		if (!api) throw new Error(`${model.provider}/${model.id} has no server-side compaction`);
		const active = new Set(pi.getActiveTools());
		const tools = pi
			.getAllTools()
			.filter((tool) => active.has(tool.name))
			.map(({ name, description, parameters }) => ({ name, description, parameters }));
		const messages = [
			// The earlier summary, whoever wrote it; replay swaps in its checkpoint when this extension did.
			...(preparation.previousSummary ? [summaryMessage(preparation.previousSummary)] : []),
			...convertToLlm([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]),
		].filter((message) => message.role !== "system");
		const instructions = customInstructions
			? `Summarize the conversation so another model can continue the work. Additional focus: ${customInstructions}`
			: undefined;
		const collect = collector(api);
		const response = await ctx.modelRegistry
			.streamSimple(
				model,
				{ systemPrompt: ctx.getSystemPrompt(), messages, tools },
				{
					signal,
					cacheRetention: "none",
					onPayload: (payload) => {
						const replayed = previous && replay(payload, previous.details.checkpoint, summaryText(previous.summary));
						return compactionRequest(api, replayed ?? payload, instructions);
					},
					onProviderStreamEvent: (event) => collect.observe(event),
				},
			)
			.result();
		signal.throwIfAborted();
		const native = collect.result(model.id);
		if ("error" in native) throw new Error(response.errorMessage ? `${native.error}: ${response.errorMessage}` : native.error);

		const { readFiles, modifiedFiles } = fileLists(preparation);
		let checkpoint: Checkpoint = native.checkpoint;
		let summary: string;
		let usage = native.usage ?? response.usage;
		if (checkpoint.api === "anthropic-messages") {
			// File lists stay outside the signed block, which the server rejects if changed.
			const fileContext = formatFiles(readFiles, modifiedFiles);
			checkpoint = { ...checkpoint, fileContext };
			summary = `${native.summary}${fileContext}`;
		} else {
			// The Codex checkpoint is opaque; pi's text summary serves other models and precedes it on replay.
			const text = await compact(preparation, model, undefined, undefined, customInstructions, signal, undefined, (m, c, o) =>
				ctx.modelRegistry.streamSimple(m, c, o),
			);
			summary = text.summary;
			if (text.usage) usage = addUsage(usage, text.usage);
		}
		signal.throwIfAborted();
		const details: Details = { readFiles, modifiedFiles, checkpoint };
		return { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore, usage, details };
	}

	pi.on("session_before_compact", async (event, ctx) => {
		const { preparation, branchEntries, customInstructions, signal } = event;
		const model = compactionModel(ctx, branchEntries);
		if (!model) return;
		const previous = latestCheckpoint(branchEntries);
		// pi carries file lists forward only from its own compactions.
		for (const file of previous?.details.readFiles ?? []) preparation.fileOps.read.add(file);
		for (const file of previous?.details.modifiedFiles ?? []) preparation.fileOps.edited.add(file);
		try {
			return { compaction: await serverCompaction(ctx, model, preparation, previous, customInstructions, signal) };
		} catch (error) {
			if (signal.aborted) return;
			// pi's own summary runs next, so a provider that rejects server compaction still compacts.
			if (ctx.hasUI) ctx.ui.notify(`Server compaction failed, using pi's summary: ${(error as Error).message}`, "warning");
			return;
		}
	});

	pi.on("before_provider_request", (event, ctx) => {
		const previous = latestCheckpoint(ctx.sessionManager.getBranch());
		return previous && replay(event.payload, previous.details.checkpoint, summaryText(previous.summary));
	});
}
