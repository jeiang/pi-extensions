import assert from "node:assert/strict";
import { test } from "node:test";
import { parseStatus } from "../extensions/footer/index.ts";

test("git status counts staged, unstaged, and untracked paths", () => {
	const output = [
		"# branch.oid abc",
		"# branch.head feat/x",
		"1 M. N... 100644 100644 100644 a b staged.ts",
		"1 .M N... 100644 100644 100644 a b unstaged.ts",
		"1 MM N... 100644 100644 100644 a b both.ts",
		"2 R. N... 100644 100644 100644 a b R100 new.ts\told.ts",
		"? untracked.ts",
		"",
	].join("\n");
	assert.deepEqual(parseStatus(output), { branch: "feat/x", unstaged: 2, staged: 3, untracked: 1 });
});
