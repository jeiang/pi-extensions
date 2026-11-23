import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type Checkpoint,
	COMPACTION_BETA,
	collector,
	compactionRequest,
	nativeApi,
	readDetails,
	replay,
} from "../extensions/server-compaction/protocol.ts";

type Event = Record<string, unknown>;

const marker = "SUMMARY MARKER";
const block = { type: "compaction", content: "Parser decision", signature: "signed" };
const item = { type: "compaction", id: "cmp_1", encrypted_content: "opaque" };
const anthropic: Checkpoint = { api: "anthropic-messages", model: "claude", block, fileContext: "\n\n<read-files>\na.ts\n</read-files>" };
const codex: Checkpoint = { api: "openai-codex-responses", model: "gpt", item };
const summary = { role: "user", content: [{ type: "text", text: marker, cache_control: { type: "ephemeral" } }] };

function model(provider: string, api: string, baseUrl: string): Model<Api> {
	return { id: "m", name: "m", provider, api, baseUrl } as Model<Api>;
}

function anthropicEvents(compaction: Event = block, stop = "compaction"): Event[] {
	return [
		{ type: "message_start", message: { id: "msg", usage: { input_tokens: 0, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: compaction },
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: stop },
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				iterations: [{ type: "compaction", input_tokens: 819, output_tokens: 129, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }],
			},
		},
	];
}

function collect(api: "anthropic-messages" | "openai-codex-responses", events: Event[], modelId: string) {
	const collected = collector(api);
	for (const event of events) collected.observe(event);
	return collected.result(modelId);
}

test("covers Anthropic's own endpoint and Codex only", () => {
	assert.equal(nativeApi(model("anthropic", "anthropic-messages", "https://api.anthropic.com")), "anthropic-messages");
	assert.equal(nativeApi(model("anthropic", "anthropic-messages", "https://proxy.example")), undefined);
	assert.equal(nativeApi(model("openai-codex", "openai-codex-responses", "https://chatgpt.com/backend-api")), "openai-codex-responses");
	assert.equal(nativeApi(model("mistral", "mistral-conversations", "https://api.mistral.ai")), undefined);
});

test("asks Anthropic to summarize with the compaction beta", () => {
	assert.deepEqual(compactionRequest("anthropic-messages", { model: "claude", betas: ["oauth"] }, "focus"), {
		model: "claude",
		betas: ["oauth", COMPACTION_BETA],
		compaction: { type: "summarize", instructions: "focus" },
	});
});

test("appends the Codex trigger after any instructions", () => {
	assert.deepEqual(compactionRequest("openai-codex-responses", { input: [{ role: "user" }] }, "focus")?.input, [
		{ role: "user" },
		{ role: "developer", content: "focus" },
		{ type: "compaction_trigger" },
	]);
});

test("accepts the live Anthropic shape, without encrypted_content, and counts iteration usage", () => {
	const result = collect("anthropic-messages", anthropicEvents(), "claude");
	if ("error" in result) assert.fail(result.error);
	assert.deepEqual(result.checkpoint, { api: "anthropic-messages", model: "claude", block, fileContext: "" });
	assert.equal(result.summary, "Parser decision");
	assert.equal(result.usage?.input, 819);
	assert.equal(result.usage?.totalTokens, 948);
});

test("takes Anthropic compaction deltas as final values", () => {
	const events = anthropicEvents({ type: "compaction", content: null });
	events.splice(
		2,
		0,
		{ type: "content_block_delta", index: 0, delta: { type: "compaction_delta", content: "draft" } },
		{ type: "content_block_delta", index: 0, delta: { type: "compaction_delta", content: "final" } },
	);
	const result = collect("anthropic-messages", events, "claude");
	assert.equal("error" in result ? result.error : result.summary, "final");
});

test("rejects incomplete Anthropic responses", () => {
	const cases: Record<string, Event[]> = {
		"wrong stop reason": anthropicEvents(block, "max_tokens"),
		"empty summary": anthropicEvents({ ...block, content: " " }),
		"unfinished block": anthropicEvents().filter((event) => event.type !== "content_block_stop"),
		"two blocks": [
			...anthropicEvents().slice(0, 2),
			{ type: "content_block_start", index: 1, content_block: block },
			...anthropicEvents().slice(2),
		],
	};
	for (const [name, events] of Object.entries(cases)) assert.ok("error" in collect("anthropic-messages", events, "claude"), name);
});

test("keeps exactly one complete Codex item and ignores other output", () => {
	const events = [
		{ type: "response.output_item.done", item: { type: "message", content: [] } },
		{ type: "response.output_item.done", item },
		{ type: "response.completed", response: { status: "completed" } },
	];
	assert.deepEqual(collect("openai-codex-responses", events, "gpt"), { checkpoint: codex });
});

test("rejects incomplete Codex responses", () => {
	const completed = { type: "response.completed", response: { status: "completed" } };
	const cases: Record<string, Event[]> = {
		incomplete: [{ type: "response.output_item.done", item }, { type: "response.incomplete", response: { status: "incomplete" } }],
		"no item": [completed],
		"empty item": [{ type: "response.output_item.done", item: { ...item, encrypted_content: "" } }, completed],
	};
	for (const [name, events] of Object.entries(cases)) assert.ok("error" in collect("openai-codex-responses", events, "gpt"), name);
});

test("replays the Anthropic block first, then the file lists, with the beta", () => {
	const payload = { model: "claude", betas: ["oauth"], messages: [summary, { role: "user", content: "next" }] };
	assert.deepEqual(replay(payload, anthropic, marker), {
		model: "claude",
		betas: ["oauth", COMPACTION_BETA],
		messages: [
			{ role: "assistant", content: [block] },
			{ role: "user", content: anthropic.fileContext },
			{ role: "user", content: "next" },
		],
	});
});

test("replays the Codex item after its summary", () => {
	const user = { role: "user", content: [{ type: "input_text", text: marker }] };
	assert.deepEqual(replay({ model: "gpt", input: [user, { role: "user" }] }, codex, marker)?.input, [user, item, { role: "user" }]);
});

test("leaves other payloads unchanged", () => {
	const cases: [string, unknown, Checkpoint][] = [
		["another model", { model: "other", messages: [summary] }, anthropic],
		["another API", { model: "claude", input: [summary] }, anthropic],
		["no summary message", { model: "claude", messages: [{ role: "user", content: "hi" }] }, anthropic],
		["not an object", "text", codex],
	];
	for (const [name, payload, checkpoint] of cases) assert.equal(replay(payload, checkpoint, marker), undefined, name);
});

test("reads valid session details and rejects malformed ones", () => {
	const details = { readFiles: [], modifiedFiles: [], checkpoint: codex };
	assert.deepEqual(readDetails(details), details);
	assert.equal(readDetails({ readFiles: [], modifiedFiles: [] }), undefined);
	assert.equal(readDetails({ ...details, checkpoint: { ...codex, item: { type: "compaction" } } }), undefined);
	assert.equal(readDetails({ ...details, checkpoint: { ...anthropic, block: { content: 1 } } }), undefined);
});
