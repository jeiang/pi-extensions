import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import codemode from "../extensions/codemode/index.ts";
import workspace from "../extensions/workspace/index.ts";
import { createTestSession, type Reply, scriptedProviders } from "./harness.ts";

/** Runs `code` as the first tool call; `then` is the second call, so a background script can finish meanwhile. */
async function script(code: string, then?: Reply) {
	const results: string[] = [];
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "codemode-")));
	const { session } = await createTestSession({
		extensions: [
			scriptedProviders((_m, context, i): Reply => {
				const last = context.messages.at(-1);
				if (last?.role === "toolResult") results.push(last.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"));
				if (i === 0) return { tool: "codemode", args: { code } };
				return i === 1 && then ? then : { text: "done" };
			}, []),
			workspace,
			codemode,
		],
		model: ["p1", "m"],
		cwd: dir,
		settings: { defaultTools: ["+codemode"] },
	});
	await session.prompt("go");
	const description = session.state.tools.find((tool) => tool.name === "codemode")?.description ?? "";
	const woken = session.messages.flatMap((m) => (m.role === "custom" && typeof m.content === "string" ? [m.content] : []));
	session.dispose();
	return { result: results[0] ?? "", description, woken };
}

test("the wrapped codemode lists the helpers and runs them after an options line", async () => {
	const ok = await script('// @options: {"timeout_ms": 30000}\nconst out = await sh("echo hi");\nconst r = await run("exit 3");\nreturn [out.trim(), r.exit_code, (await settle([Promise.reject(new Error("no"))]))[0]];');
	assert.match(ok.description, /Helpers defined in every script/);
	assert.match(ok.result, /Script completed/);
	assert.match(ok.result, /"hi",\s*3,\s*"Error: no"/);

	const shadowed = await script("const sh = 1;\nreturn sh;");
	assert.match(shadowed.result, /Script completed[\s\S]*\n1\b/);
});

test("a tool that takes an action gets a method per action", async () => {
	const ok = await script(`return typeof tools.shell.status === "function" ? (await tools.shell.status()).output : "missing";`);
	assert.match(ok.result, /Script completed[\s\S]*No jobs/);
});

test("json() finds the JSON when progress lines came first", async () => {
	const ok = await script(`return (await json("echo unpacking; echo '{\\"a\\":1}'")).a === 1 ? "parsed" : "wrong";`);
	assert.match(ok.result, /Script completed[\s\S]*parsed/);
});

test("fs writes a file and reads back a window of it", async () => {
	const ok = await script(`await fs.write("notes.txt", "one\\ntwo\\nthree\\n");
return (await fs.rows("notes.txt", 1, 2)).includes("2:");`);
	assert.match(ok.result, /Script completed[\s\S]*\ntrue/);
});

test("fs reads a file's raw text and lists the working tree", async () => {
	const ok = await script(`await fs.write("notes.txt", "one\\ntwo\\nthree\\n");
const names = lines(await fs.text("notes.txt"));
return [names.length, (await fs.glob("*.txt")).length];`);
	assert.match(ok.result, /\[3,\s*1\]/);
});

test("the text helpers count, and put() refuses a large value in an unsaved session", async () => {
	const ok = await script(`await put("small", { n: 2 });
const grouped = count(lines("a\\nb\\na"));
const blob = await put("big", { text: "a".repeat(70000) }).then(() => "stored", (e) => e.message.includes("nowhere to spill"));
return [grouped[0][0], grouped.length, median([1, 2, 3, 4]), (await get("small")).n, blob];`);
	assert.match(ok.result, /\["a",\s*2,\s*2\.5,\s*2,\s*true\]/);
});

test("stdout and stderr stay apart, so .json() parses and .jsonErr() sees the other stream", async () => {
	const ok = await script(
		`await fs.write("a.json", '{"a":1}'); await fs.write("b.json", '{"b":2}');
const r = await run("cat a.json; cat b.json >&2");
return [r.json().a, r.jsonErr().b, r.output.includes("a"), r.stderr.includes("b")];`,
	);
	assert.match(ok.result, /\[1,2,true,true\]/);
});

test("a // @background script returns at once and wakes the session with its output", async () => {
	const run = await script('// @background\nawait sleep(1);\nreturn (await sh("echo late")).trim();', { tool: "codemode", args: { code: "await sleep(2);" } });
	assert.match(run.result, /in the background/);
	assert.match(run.woken.join("\n"), /finished:[\s\S]*late/);
});
