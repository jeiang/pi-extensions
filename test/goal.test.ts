import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptContext } from "@earendil-works/pi-ai/compat";
import goal from "../extensions/goal/index.ts";
import { type Call, createTestSession, scriptedProviders } from "./harness.ts";

type Reply = "report" | "complete";

/** Replies in order; a "report" is the response that used to end the run and wait for the user. */
async function run(replies: Reply[], prompts: string[]) {
	const calls: Call[] = [];
	const seen: string[] = [];
	const { session } = await createTestSession({
		extensions: [
			scriptedProviders((_model, context: TranscriptContext, index) => {
				seen.push(JSON.stringify(context.messages.at(-1)?.content));
				return replies[index] === "complete"
					? { tool: "goal", args: { op: "complete", summary: "cache written and tested" } }
					: { text: "**Result** Cache written. **Needs you** Start the next milestone." };
			}, calls),
			goal,
		],
		model: ["p1", "m"],
	});
	for (const prompt of prompts) {
		await session.prompt(prompt);
		await session.waitForIdle();
	}
	const branch = session.sessionManager.getBranch();
	session.dispose();
	return { calls, branch, seen };
}

test("a response that only reports does not end the goal", async () => {
	const { calls, seen } = await run(["report", "complete"], ["/goal add the cache"]);
	assert.equal(calls.length, 2);
	// The continuation reaches the model as the newest message, with the real budget and the report it must not stop on.
	assert.match(seen[1] ?? "", /Continuation 1/);
	assert.match(seen[1] ?? "", /Context: \d+k of 100k used \(\d+%\). It is never a reason to stop/);
	assert.match(seen[1] ?? "", /Your last response ended with: .*Needs you/);
});

test("completing the goal ends the run, and the goal does not resume on the next prompt", async () => {
	const { calls, branch } = await run(["complete", "report"], ["/goal add the cache", "thanks"]);
	assert.equal(calls.length, 2);
	const complete = branch
		.filter((entry) => entry.type === "custom" && entry.customType === "goal")
		.pop() as { data?: { status?: string } } | undefined;
	assert.equal(complete?.data?.status, "complete");
});

test("without a goal a response that only reports settles", async () => {
	const { calls } = await run(["report"], ["what is left?"]);
	assert.equal(calls.length, 1);
});
