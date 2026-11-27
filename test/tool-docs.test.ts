import assert from "node:assert/strict";
import { test } from "node:test";
import github from "../extensions/github/index.ts";
import goal from "../extensions/goal/index.ts";
import nix from "../extensions/nix/index.ts";
import papercuts from "../extensions/papercuts/index.ts";
import plan from "../extensions/plan/index.ts";
import toolDocs, { habitsSection, loadDocs, rank, renderParams } from "../extensions/tool-docs/index.ts";
import workspace from "../extensions/workspace/index.ts";

/** The tools an extension registers, from a stand-in pi that ignores everything else. */
function registered(extension: (pi: never) => void): { name: string; description: string; parameters?: unknown; exposure?: string }[] {
	const tools: { name: string; description: string; parameters?: unknown; exposure?: string }[] = [];
	const pi = new Proxy(
		{},
		{
			get: (_target, key) => {
				if (key === "registerTool") return (tool: { name: string; description: string; parameters?: unknown; exposure?: string }) => tools.push(tool);
				if (key === "getAllTools" || key === "getActiveTools") return () => [];
				return () => undefined;
			},
		},
	);
	extension(pi as never);
	return tools;
}

const ours = [workspace, github, nix, plan, goal, papercuts, toolDocs].flatMap(registered);

test("every tool these extensions register has a doc with its purpose, habits, and examples", () => {
	const docs = loadDocs();
	for (const tool of ours) {
		const doc = docs.get(tool.name);
		assert.ok(doc, `docs/tools/${tool.name}.md is missing`);
		assert.ok(doc.purpose, `${tool.name}: no purpose line`);
		assert.match(doc.body, /## Use instead of/, tool.name);
		assert.match(doc.body, /## Examples/, tool.name);
	}
});

test("a query finds the tool by the habit it replaces, and parameters come from the live schema", () => {
	const docs = loadDocs();
	assert.equal(rank("gh pr checks watch without merging", ours, docs)[0]?.name, "github");
	assert.equal(rank("scp a file to a host", ours, docs)[0]?.name, "transfer");
	const run = ours.find((tool) => tool.name === "run");
	assert.match(renderParams(run?.parameters), /^- command: string — /m);
	assert.match(renderParams(run?.parameters), /^- host\?: string/m);
	assert.match(habitsSection(docs, new Set(["run"])), /run\(cmd, \{ host, devshell \}\)/);
	assert.doesNotMatch(habitsSection(docs, new Set(["run"])), /pr_watch/);
});
