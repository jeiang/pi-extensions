import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createAdvisor, parseAdvice } from "../extensions/advisor/index.ts";
import type { JsonObject } from "@earendil-works/pi-ai";
import { type Call, createTestSession, scriptedProviders } from "./harness.ts";

const fakeTool = (pi: ExtensionAPI, name: string) => {
	pi.registerTool({
		name,
		label: name,
		description: "Returns ok.",
		parameters: Type.Object({ op: Type.Optional(Type.String()), method: Type.Optional(Type.String()) }),
		async execute() {
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
	});
};

async function run(advice: string, acts = true, tool = "edit", args: JsonObject = {}) {
	const calls: Call[] = [];
	const { session } = await createTestSession({
		extensions: [
			scriptedProviders((model, _context, index) => {
				if (model === "p2/m") return { text: advice };
				return acts && index === 0 ? { tool, args } : { text: "main answer" };
			}, calls),
			(pi) => fakeTool(pi, "edit"),
			(pi) => fakeTool(pi, "github"),
			createAdvisor({ models: ["p2/m:low"], enabled: true }),
		],
		model: ["p1", "m"],
	});
	await session.prompt("do it");
	const entries = session.sessionManager.getBranch();
	session.dispose();
	return {
		models: calls.map((call) => call.model),
		nits: entries.flatMap((entry) => (entry.type === "custom" && entry.customType === "advisor-nits" ? [entry.data] : [])),
		lastRole: calls.at(-1)?.lastRole,
	};
}

test("a concern continues the run once, and the advisor does not loop", async () => {
	const { models, lastRole } = await run("concern: the tests were never run.");
	assert.deepEqual(models, ["p1/m", "p1/m", "p2/m", "p1/m"]);
	// The advice reaches the model as the newest message.
	assert.equal(lastRole, "user");
});

test("LGTM continues nothing", async () => {
	assert.deepEqual((await run("LGTM")).models, ["p1/m", "p1/m", "p2/m"]);
});

test("nits are recorded for display and do not continue the run", async () => {
	const { models, nits } = await run("nit: the variable name is stale.");
	assert.deepEqual(models, ["p1/m", "p1/m", "p2/m"]);
	assert.deepEqual(nits, ["nit: the variable name is stale."]);
});

test("a run that only merged a pull request is reviewed", async () => {
	assert.deepEqual((await run("LGTM", true, "github", { op: "pr_merge", method: "squash" })).models, ["p1/m", "p1/m", "p2/m"]);
});

test("a run without a file or process tool call is not reviewed", async () => {
	assert.deepEqual((await run("concern: x", false)).models, ["p1/m"]);
});

test("parseAdvice separates nits, caps them at two, and treats unlabeled advice as serious", () => {
	assert.deepEqual(parseAdvice("- `blocker`: A.\n  evidence\n- nit: B.\n- nit: C.\n- nit: D.\n2. **concern**: E."), {
		serious: "- `blocker`: A.\n  evidence\n2. **concern**: E.",
		nits: "- nit: B.\n- nit: C.",
	});
	assert.deepEqual(parseAdvice("Run the tests first."), { serious: "Run the tests first.", nits: "" });
});
