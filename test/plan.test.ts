import assert from "node:assert/strict";
import { test } from "node:test";
import { planViolation } from "../extensions/plan/index.ts";

const dir = "/s/plans";
const cwd = "/w";
const reason = (tool: string, input: Record<string, unknown>) => planViolation(tool, input, dir, cwd);

test("plan mode blocks writes outside the plan directory and allows the plan's own files", () => {
	assert.equal(reason("write", { path: "/s/plans/a.md" }), undefined);
	assert.match(reason("write", { path: "/w/x.ts" }) ?? "", /only files in \/s\/plans/);
	assert.equal(reason("replace", { path: "/s/plans/a.md" }), undefined);
	assert.equal(reason("edit", { path: "/s/plans/a.md", edits: [] }), undefined);
	assert.match(reason("edit", { path: "/w/source.ts", edits: [] }) ?? "", /only files in/);
	assert.equal(reason("substitute", { pattern: "a", replacement: "b", apply: true, paths: ["/s/plans/a.md"] }), undefined);
	// A preview writes nothing.
	assert.equal(reason("substitute", { pattern: "a", replacement: "b" }), undefined);
});

test("plan mode blocks renames, worktree changes, and pull requests, and leaves shell to the prompt", () => {
	assert.match(reason("edit", { input: '[a.ts#AAAA]\nMV b.ts' }) ?? "", /deleting or renaming/);
	assert.match(reason("worktree", { action: "create", name: "x" }) ?? "", /worktree changes/);
	assert.equal(reason("worktree", { action: "list" }), undefined);
	assert.match(reason("github", { op: "pr_merge", method: "squash" }) ?? "", /pull request changes/);
	assert.equal(reason("github", { op: "pr_view" }), undefined);
	// A command may act, but only the model can tell; the planning prompt forbids it.
	assert.equal(reason("shell", { command: "rm -rf /" }), undefined);
	assert.equal(reason("codemode", { code: "return 1" }), undefined);
});
