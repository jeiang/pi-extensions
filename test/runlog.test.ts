import assert from "node:assert/strict";
import { test } from "node:test";
import { resumeNotice, unanswered } from "../extensions/runlog/index.ts";

test("unanswered finds the calls whose result never landed, with what re-issuing them would do", () => {
	const entries = [
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "a", name: "read", input: { path: "f.txt" } },
					{ type: "toolCall", id: "b", name: "edit", input: { input: "[f.txt#ABCD]\nPUT 1.=1:\n+x" } },
				],
			},
		},
		{ type: "message", message: { role: "toolResult", toolCallId: "a", content: [] } },
	];
	const calls = unanswered(entries, "/tmp");
	assert.deepEqual(
		calls.map((call) => `${call.name}:${call.effect}`),
		["edit:write"],
	);
	const notice = resumeNotice(calls) ?? "";
	assert.match(notice, /stopped before this call returned/);
	assert.match(notice, /edit .*check the file or the remote state/);
});

test("a resume with nothing in flight says nothing", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", input: {} }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "a", content: [] } },
	];
	assert.deepEqual(unanswered(entries, "/tmp"), []);
	assert.equal(resumeNotice([]), undefined);
});
