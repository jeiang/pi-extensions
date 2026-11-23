import { createCodemodeExtension, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";

/** Helpers every script gets. One line, so the script's own line numbers do not move. */
export const PRELUDE = [
	"const run = (command, o = {}) => tools.bash({ command, ...o });",
	"const sh = async (command, { check = true, ...o } = {}) => { const r = await run(command, o); if (check && r.exit_code !== 0) throw new Error(`exit ${r.exit_code}: ${command}\\n${r.output.slice(-2000)}\\nlog: ${r.log}`); return r.output; };",
	"const json = async (command, o) => { const out = await sh(command, o); try { return JSON.parse(out); } catch { throw new Error(`not JSON from ${command}: ${out.slice(0, 500)}`); } };",
	"const settle = async (list) => (await Promise.allSettled(list)).map((x) => (x.status === 'fulfilled' ? x.value : `Error: ${x.reason?.message ?? x.reason}`));",
	"const sleep = (seconds) => tools.sleep({ seconds });",
	"const poll = async (fn, { every = 15, timeout = 600 } = {}) => { const end = Date.now() + timeout * 1000; for (;;) { const v = await fn(); if (v) return v; if (Date.now() + every * 1000 > end) throw new Error(`poll timed out after ${timeout}s`); await sleep(every); } };",
	"const mapLimit = async (items, n, fn) => { const out = new Array(items.length); let next = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } })); return out; };",
	"const job = (command, o = {}) => tools.shell({ command, background: true, ...o });",
].join(" ");

const HELPERS = `Helpers defined in every script:
- run(cmd, { cwd, tail, timeout }) → { output, exit_code, log, truncated }, also for a non-zero exit; output holds up to 1 MiB. sh(cmd, { check = true, ... }) → output, throws on a non-zero exit; json(cmd, opts) → parsed output.
- settle(promises) → each value, or "Error: …" for a rejection. mapLimit(items, n, fn) runs fn at most n at a time.
- sleep(s); poll(fn, { every = 15, timeout = 600 }) → the first truthy fn() result.
- job(cmd, { wait_on, wait_seconds }) → a background shell job { job, status, log }; tools.shell({ action: "wait", job, wait_on }) waits on it. You are woken when it exits.
A first line \`// @background\` runs the whole script in the background: the call returns at once and you are woken with its output. It holds one of two script workers until it ends, so give it a timeout_ms on a second \`// @options\` line.

The script is the program; a command runs one external program:
- One program per run(). Independent commands go in separate calls under settle(), so each keeps its own exit code and output and one failure does not hide the rest.
- Filter, count, sort, and join in JS, not with \`;\` chains or pipes into head, tail, grep, sort, awk, or jq. Prefer a command's --json output with json().
- Keep intermediate results in variables, or in store()/load() across scripts, not in /tmp files.
- Structured tools: tools.ls → { entries }, tools.find → { paths }, tools.grep → { lines, files }, tools.read_text → { text, lines }.
- Return only what you need to see.

\`\`\`js
const [log, status, top, readme] = await settle([
  sh("git log --oneline -20"),
  sh("git status --short"),
  tools.ls({ path: "." }),
  tools.read_text({ path: "README.md" }),
]);
return { log, status, dirs: top.entries?.filter((e) => e.endsWith("/")), readme: readme.text?.slice(0, 1500) };
\`\`\`
\`\`\`js
const files = (await sh("git ls-files")).split("\\n").filter(Boolean);
const perDir = {};
for (const f of files) { const d = f.split("/").slice(0, 2).join("/"); perDir[d] = (perDir[d] ?? 0) + 1; }
return Object.entries(perDir).sort((a, b) => b[1] - a[1]).slice(0, 30);
\`\`\`
\`\`\`js
const r = await run("npm test", { tail: 40, timeout: 600 });
if (r.exit_code === 0) return "tests pass";
const { lines } = await tools.grep({ pattern: "FAIL|Error", path: r.log, context: 2 });
return { tail: r.output, failures: lines.map((l) => l.text) };
\`\`\``;

const GUIDELINE =
	"Run commands through codemode and write the work as a JS program: one external program per run(), independent commands in parallel with settle(), output filtered and joined in JS instead of pipes, `;` chains, or /tmp files.";

/** Puts the prelude in a block around the script, after the options line if there is one. */
export function withPrelude(code: string): string {
	const options = /^\/\/ @options:[^\n]*\n?/.exec(code)?.[0] ?? "";
	return `${options}${PRELUDE} {${code.slice(options.length)}\n}`;
}

/** Captures the built-in codemode tool and re-registers it with the helpers and a guideline about writing programs. */
export default function (pi: ExtensionAPI) {
	let builtin: ToolDefinition | undefined;
	const capture = new Proxy(pi, {
		get(target, key) {
			if (key === "registerTool") return (definition: ToolDefinition) => (builtin = definition);
			const value: unknown = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	createCodemodeExtension()(capture);
	if (!builtin) throw new Error("codemode: the built-in extension registered no tool; check it against this wrapper after a pi update.");
	const original = builtin;
	pi.registerTool({
		...original,
		promptGuidelines: [GUIDELINE],
		prepareLoadout: original.prepareLoadout
			? (loadout) => {
					const result = original.prepareLoadout?.(loadout);
					const description = result?.descriptions?.[original.name];
					return result && description ? { ...result, descriptions: { ...result.descriptions, [original.name]: `${description}\n\n${HELPERS}` } } : result;
				}
			: undefined,
		execute: async (id, params: { code: string }, signal, onUpdate, ctx) => {
			const background = /^\/\/ @background[^\n]*\n/.exec(params.code);
			if (!background) return original.execute(id, { ...params, code: withPrelude(params.code) }, signal, onUpdate, ctx);
			const code = withPrelude(params.code.slice(background[0].length));
			const wake = (content: string, error: boolean) =>
				pi.sendMessage({ customType: "codemode-background", content, display: true, details: { error } }, { triggerTurn: true, deliverAs: "steer" });
			// A background script outlives its tool call, so only session shutdown cancels it.
			void original.execute(id, { code }, shutdown.signal, undefined, ctx).then(
				(result) => wake(`Background script ${id} finished:\n${result.content.map((part) => (part.type === "text" ? part.text : "")).join("")}`, Boolean(result.isError)),
				(error: Error) => wake(`Background script ${id} failed: ${error.message}`, true),
			);
			return { content: [{ type: "text", text: `Started script ${id} in the background; you are woken with its result.` }], details: undefined };
		},
	});
	const shutdown = new AbortController();
	pi.on("session_shutdown", () => shutdown.abort());
}
