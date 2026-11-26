import assert from "node:assert/strict";
import { test } from "node:test";
import checkpoint, { formatStatus, gitSummary, lastCheckpoint } from "../extensions/checkpoint/index.ts";
import { createTestSession, scriptedProviders } from "./harness.ts";

const STATE = "done: parser\nnext: tests\nblocked: none\nwhere: feat/parser\nchecks: bun test passes";

test("the checkpoint tool records the state on the branch, and /status renders it with the checkout", async () => {
	const results: string[] = [];
	const { session } = await createTestSession({
		extensions: [
			scriptedProviders((_m, context, i) => {
				const last = context.messages.at(-1);
				if (last?.role === "toolResult") results.push(last.content.map((c) => (c.type === "text" ? c.text : "")).join(""));
				return i === 0 ? { tool: "checkpoint", args: { state: STATE } } : { text: "done" };
			}, []),
			checkpoint,
		],
		model: ["p1", "m"],
	});
	await session.prompt("record");
	const recorded = lastCheckpoint(session.sessionManager);
	session.dispose();
	assert.equal(recorded?.state, STATE);
	assert.match(results[0] ?? "", /Recorded/);
	assert.match(formatStatus(recorded, "main (clean)"), /done: parser[\s\S]*Checkout:\nmain \(clean\)/);
	assert.match(formatStatus(undefined, ""), /No checkpoint yet/);
});

test("gitSummary is empty outside a repository", () => {
	assert.equal(gitSummary("/nix/store"), "");
});
