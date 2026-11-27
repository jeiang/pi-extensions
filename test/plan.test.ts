import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPlan, planViolation } from "../extensions/plan/index.ts";
import { addStep, parseSteps, progressLine, setDone } from "../extensions/plan/todo.ts";

const dir = "/s/plans";
const cwd = "/w";
const reason = (tool: string, input: Record<string, unknown>) => planViolation(tool, input, dir, cwd);

test("a proposal names the plan that exists, and nothing outside the plan directory", () => {
	const dir = mkdtempSync(join(tmpdir(), "plan-files-"));
	writeFileSync(join(dir, "add-cache.md"), "# plan\n");
	writeFileSync(join(tmpdir(), "outside-plan.md"), "# other\n");
	assert.equal(findPlan(dir, "add-cache"), join(dir, "add-cache.md"));
	assert.equal(findPlan(dir, "add-cache.md"), join(dir, "add-cache.md"));
	// A typo is not another plan, and a slug cannot walk out of the directory.
	assert.equal(findPlan(dir, "add-cach"), undefined);
	assert.equal(findPlan(dir, "../outside-plan"), undefined);
});

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
	assert.equal(reason("run", { command: "rm -rf /" }), undefined);
	assert.equal(reason("codemode", { code: "return 1" }), undefined);
});

test("the progress list checks, unchecks, and adds steps in place, leaving the rest of the plan alone", () => {
	const plan = "# Plan\n\nText with [ ] brackets.\n\n## Steps\n- [ ] parse\n  - [x] nested\n- [ ] wire\n\n## Notes\nend\n";
	assert.deepEqual(parseSteps(plan).map((s) => [s.id, s.done, s.text]), [[1, false, "parse"], [2, true, "nested"], [3, false, "wire"]]);
	const checked = setDone(plan, 3, true);
	assert.equal(checked, plan.replace("- [ ] wire", "- [x] wire"));
	assert.equal(setDone(checked, 3, false), plan);
	assert.equal(addStep(plan, "ship"), plan.replace("- [ ] wire\n", "- [ ] wire\n- [ ] ship\n"));
	assert.equal(addStep("", "first"), "- [ ] first\n");
	assert.throws(() => setDone(plan, 9, true), /No step 9/);
	assert.equal(progressLine(parseSteps(checked)), "☐ 2/3 · parse");
});
