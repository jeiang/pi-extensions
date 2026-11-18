import assert from "node:assert/strict";
import { test } from "node:test";
import { addedLines, lintLines } from "../extensions/lint/index.ts";

test("flags history comments, TODOs and debug output on added lines only", () => {
	const diff = [" 1 const a = 1;", "-2 old", "+2 // previously this used a map", "+3 # TODO wire this up", "+4 console.log(x)", "+5 const used = 2; // no longer needed after the refactor"].join("\n");
	const findings = lintLines(addedLines(diff));
	assert.deepEqual(
		findings.map((f) => f.line),
		[2, 3, 4, 5],
	);
});

test("leaves ordinary code and prose alone", () => {
	const lines: [number, string][] = [
		[1, "const previouslySeen = new Set();"],
		[2, "// Returns the cache used to index files."],
		[3, 'log.info("no longer reachable")'],
	];
	assert.deepEqual(lintLines(lines), []);
});
