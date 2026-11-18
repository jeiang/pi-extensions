import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createChains, parseTarget } from "../extensions/chains/index.ts";
import { type Call, createTestSession, type Script, scriptedProviders } from "./harness.ts";

const echoTool = (pi: ExtensionAPI) => {
	pi.registerTool({
		name: "echo",
		label: "echo",
		description: "Returns ok.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	});
};

async function run(script: Script, chain: string[] = ["p1/m:high", "p2/m:low", "p3/m"]) {
	const calls: Call[] = [];
	const cooldownFile = join(mkdtempSync(join(tmpdir(), "chains-")), "cooldown.json");
	const { session } = await createTestSession({
		extensions: [scriptedProviders(script, calls), echoTool, createChains({ chains: { test: { targets: chain } }, cooldownFile })],
		model: ["chain", "test"],
	});
	await session.prompt("go");
	const text = session.getLastAssistantText();
	session.dispose();
	return { calls, text };
}
test("parseTarget splits provider, model id and level", () => {
	assert.deepEqual(parseTarget("anthropic/claude-opus-5-5:medium"), {
		provider: "anthropic",
		id: "claude-opus-5-5",
		thinkingLevel: "medium",
	});
	assert.deepEqual(parseTarget("cloudflare-workers-ai/@cf/cloudflare/clef-flash"), {
		provider: "cloudflare-workers-ai",
		id: "@cf/cloudflare/clef-flash",
		thinkingLevel: "medium",
	});
});

test("a retryable error moves the retry to the next provider", async () => {
	const { calls, text } = await run((model) => (model === "p1/m" ? { error: "429 rate limit exceeded" } : { text: "done" }));
	assert.deepEqual(
		calls.map((c) => c.model),
		["p1/m", "p2/m"],
	);
	assert.equal(text, "done");
});

test("a usage limit after tool results falls back and continues the run", async () => {
	const { calls, text } = await run((model, _context, index) => {
		if (index === 0) return { tool: "echo", args: {} };
		if (model === "p1/m") return { error: "Codex error: The usage limit has been reached" };
		return { text: "done" };
	});
	assert.deepEqual(
		calls.map((c) => c.model),
		["p1/m", "p1/m", "p2/m"],
	);
	assert.equal(calls[1]?.lastRole, "toolResult");
	assert.equal(text, "done");
});

test("continuation requests stay on the model that answered", async () => {
	const { calls } = await run((_model, _context, index) => (index < 2 ? { tool: "echo", args: {} } : { text: "done" }), [
		"p1/m",
		"p2/m",
	]);
	assert.deepEqual(
		calls.map((c) => c.model),
		["p1/m", "p1/m", "p1/m"],
	);
});

test("usage-limit fallbacks stop after the last target", async () => {
	const { calls } = await run(() => ({ error: "The usage limit has been reached" }), ["p1/m", "p2/m"]);
	assert.deepEqual(
		calls.map((c) => c.model),
		["p1/m", "p2/m"],
	);
});
