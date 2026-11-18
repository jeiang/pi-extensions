import assert from "node:assert/strict";
import { test } from "node:test";
import { createAdvisor } from "../extensions/advisor/index.ts";
import { type Call, createTestSession, scriptedProviders } from "./harness.ts";

async function run(advice: string) {
	const calls: Call[] = [];
	const advisorCalled = Promise.withResolvers<void>();
	const { session } = await createTestSession({
		extensions: [
			scriptedProviders((model) => {
				if (model !== "p2/m") return { text: "main answer" };
				advisorCalled.resolve();
				return { text: advice };
			}, calls),
			createAdvisor({ models: ["p2/m:low"] }),
		],
		model: ["p1", "m"],
	});
	await session.prompt("do it");
	await advisorCalled.promise;
	// The advisor's reply settles in later event-loop turns; one turn is enough for its follow-up to start.
	await new Promise((resolve) => setImmediate(resolve));
	await session.waitForIdle();
	session.dispose();
	return calls.map((call) => call.model);
}

test("advice starts one more turn, and the advisor does not loop", async () => {
	assert.deepEqual(await run("Check the tests before claiming success."), ["p1/m", "p2/m", "p1/m"]);
});

test("LGTM starts no turn", async () => {
	assert.deepEqual(await run("LGTM"), ["p1/m", "p2/m"]);
});
