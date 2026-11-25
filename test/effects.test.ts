import assert from "node:assert/strict";
import { test } from "node:test";
import { effectsOf } from "../extensions/workspace/effects.ts";

const cwd = "/w";
const kind = (tool: string, input: Record<string, unknown> = {}) => effectsOf(tool, input, cwd).kind;

test("reading leaves the working tree alone", () => {
	for (const tool of ["read", "grep", "find", "ls", "read_text", "todo", "questionnaire", "sleep", "nix", "lsp_hover", "symbol_search", "pi_lens_activate_tools"]) {
		assert.equal(kind(tool), "read", tool);
	}
	// A lens reader names a path, so it must not be mistaken for a writer.
	assert.equal(kind("symbol_search", { path: "src/main.rs" }), "read");
});

test("file tools write the paths they name", () => {
	assert.deepEqual(effectsOf("write", { path: "a.ts" }, cwd), { kind: "write", paths: ["/w/a.ts"] });
	assert.deepEqual(effectsOf("replace", { path: "@b.ts" }, cwd), { kind: "write", paths: ["/w/b.ts"] });
	assert.deepEqual(effectsOf("edit", { input: '[a.ts#AAAA]\nPUT 1.=1:\n+x\nMV "dir/c.ts"' }, cwd), {
		kind: "write",
		paths: ["/w/a.ts", "/w/dir/c.ts"],
	});
	// pi's own edit names one path instead of a patch.
	assert.deepEqual(effectsOf("edit", { path: "/w/source.ts", edits: [] }, cwd), { kind: "write", paths: ["/w/source.ts"] });
	// A substitute without apply only previews.
	assert.equal(kind("substitute", { pattern: "x", replacement: "y" }), "read");
	assert.deepEqual(effectsOf("substitute", { pattern: "x", replacement: "y", apply: true, paths: ["src"] }, cwd), {
		kind: "write",
		paths: ["/w/src"],
	});
});

test("calls outside the filesystem are either known to change state or opaque", () => {
	assert.equal(kind("github", { op: "pr_merge", method: "squash" }), "mutate");
	assert.equal(kind("github", { op: "pr_view" }), "read");
	assert.equal(kind("worktree", { action: "create", name: "x" }), "mutate");
	assert.equal(kind("worktree", { action: "list" }), "read");
	for (const tool of ["shell", "codemode", "ssh", "subagent"]) assert.equal(kind(tool, { command: "rm -rf /" }), "opaque", tool);
});

test("an unrecognized tool that names a path counts as a write", () => {
	assert.deepEqual(effectsOf("future_tool", { paths: ["a", "b"] }, cwd), { kind: "write", paths: ["/w/a", "/w/b"] });
	assert.equal(kind("future_tool", {}), "opaque");
});
