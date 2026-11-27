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
	const ok = await script('// @options: {"timeout_ms": 30000}\nconst out = await run("echo hi", { check: true }).text();\nconst r = await run("exit 3");\nreturn [out.trim(), r.exit_code, (await settle([Promise.reject(new Error("no"))]))[0]];');
	assert.match(ok.description, /Helpers defined in every script/);
	assert.match(ok.result, /Script completed/);
	assert.match(ok.result, /"hi",\s*3,\s*"Error: no"/);

	const shadowed = await script("const run = 1;\nreturn run;");
	assert.match(shadowed.result, /Script completed[\s\S]*\n1\b/);
});

test("a tool that takes an action gets a method per action", async () => {
	const ok = await script(`return typeof tools.job.status === "function" ? (await tools.job.status()).output : "missing";`);
	assert.match(ok.result, /Script completed[\s\S]*No jobs/);
});

test("run().json() finds the JSON when progress lines came first, and check throws on a failure", async () => {
	const ok = await script(`const failed = await run("exit 2", { check: true }).then(() => "passed", (e) => e.message.startsWith("exit 2"));
return [(await run("echo unpacking; echo '{\\"a\\":1}'").json()).a === 1 ? "parsed" : "wrong", failed];`);
	assert.match(ok.result, /Script completed[\s\S]*"parsed",\s*true/);
});

test("a command past wait_seconds returns a handle that waits, reads, and is reached by job", async () => {
	const ok = await script(`const h = await run("echo first; sleep 1; echo second", { wait_seconds: 0.2 });
const waited = await h.wait({ wait_seconds: 5 });
const late = await run("sleep 5", { background: true });
await late.kill();
return [h.status, waited.output.includes("second"), late.status];`);
	assert.match(ok.result, /\["running",\s*true,\s*"running"\]/);
});

test("interactive input reaches a running command, and a bare sudo fails at once", async () => {
	const ok = await script(`const h = await run("read line; echo got:$line", { interactive: true, background: true });
await h.write("hello\\n");
const done = await h.wait({ wait_seconds: 5 });
const sudo = await run("sudo -k true", { timeout: 20 });
return [done.output.includes("got:hello"), sudo.exit_code !== 0, sudo.wall_time_seconds < 10];`);
	assert.match(ok.result, /\[true,\s*true,\s*true\]/);
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
	const run = await script('// @background\nawait sleep(1);\nreturn (await run("echo late").text()).trim();', { tool: "codemode", args: { code: "await sleep(2);" } });
	assert.match(run.result, /in the background/);
	assert.match(run.woken.join("\n"), /finished:[\s\S]*late/);
});
