import { stripVTControlCharacters } from "node:util";
import { createCodemodeExtension, type ExtensionAPI, type ToolDefinition, type ToolLoadout } from "@earendil-works/pi-coding-agent";
import { inBackground, registerInterrupt, untilInterrupt } from "../workspace/interrupt.ts";

/** A script with no `timeout_ms` gets this deadline; the runner kills it, so a stuck script cannot hold a worker. */
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/**
 * Helpers every script gets. One line each, so the script's own line numbers do not move.
 * `SPILL` is the session's spill directory, filled in per call.
 */
function prelude(spill: string): string {
	return [
		`const SPILL = ${JSON.stringify(spill)};`,
		"const parse = (text) => { const s = String(text ?? ''); const at = Math.min(...[s.indexOf('{'), s.indexOf('[')].filter((n) => n >= 0)); if (at < 0) throw new Error(`no JSON in: ${s.slice(0, 200)}`); return JSON.parse(s.slice(at)); };",
		"const run = async (command, o = {}) => { const r = await tools.bash({ command, ...o }); r.json = () => parse(r.output); r.jsonErr = () => parse(r.stderr); return r; };",
		"const sh = async (command, { check = true, ...o } = {}) => { const r = await run(command, o); if (check && r.exit_code !== 0) throw new Error(`exit ${r.exit_code}: ${command}\\n${(r.output + (r.stderr ? `\\n${r.stderr}` : '')).slice(-2000)}\\nlog: ${r.log}`); return r.output; };",
		"const json = async (command, o) => (await run(command, o)).json();",
		"const settle = async (list) => (await Promise.allSettled(list)).map((x) => (x.status === 'fulfilled' ? x.value : `Error: ${x.reason?.message ?? x.reason}`));",
		"const sleep = (seconds) => tools.sleep({ seconds });",
		"const poll = async (fn, { every = 15, timeout = 600 } = {}) => { const end = Date.now() + timeout * 1000; for (;;) { const v = await fn(); if (v) return v; if (Date.now() + every * 1000 > end) throw new Error(`poll timed out after ${timeout}s`); await sleep(every); } };",
		"const mapLimit = async (items, n, fn) => { const out = new Array(items.length); let next = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } })); return out; };",
		"const job = (command, o = {}) => tools.shell({ command, background: true, ...o });",
		"const fs = { text: async (path) => (tools.read_text ? (await tools.read_text({ path })).text : String(await tools.read({ path }))), rows: async (path, from = 1, count = 200) => String(await tools.read({ path, ranges: [{ start: from, end: from + count - 1 }] })), write: async (path, content) => await tools.write({ path, content }), glob: async (pattern) => (await tools.find({ pattern })).paths, ls: async (path = '.') => (await tools.ls({ path })).entries };",
		"const lines = (text) => String(text).replace(/\\n$/, '').split('\\n');",
		"const page = (text, from = 1, count = 200) => { const rows = lines(text); const start = Math.max(0, from - 1); const shown = rows.slice(start, start + count).join('\\n'); return rows.length > start + count ? `${shown}\\n[${rows.length - start - count} more lines]` : shown; };",
		"const count = (items, key = (x) => x) => { const m = new Map(); for (const x of items) { const k = key(x); m.set(k, (m.get(k) ?? 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };",
		"const unique = (items) => [...new Set(items)];",
		"const sum = (items, key = (x) => x) => items.reduce((a, x) => a + Number(key(x) ?? 0), 0);",
		"const median = (items) => { const s = [...items].map(Number).sort((a, b) => a - b); return s.length ? (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2 : NaN; };",
		"const p95 = (items) => { const s = [...items].map(Number).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] : NaN; };",
		"const put = async (key, value) => { const text = JSON.stringify(value); if (text.length <= 65536) { store(key, value); return key; } if (!SPILL) throw new Error(`${key} is ${text.length} characters and this session is unsaved, so put() has nowhere to spill it. Keep it under 65536 characters or save the session.`); const path = `${SPILL}/${String(key).replace(/[^\\w.-]/g, '_')}.json`; await tools.write({ path, content: text }); store(key, { spill: path }); return path; };",
		"const get = async (key) => { const v = load(key); return v && typeof v === 'object' && typeof v.spill === 'string' ? JSON.parse(await fs.text(v.spill)) : v; };",
	].join(" ");
}

const HELPERS = `Helpers defined in every script:
- run(cmd, { cwd, tail, timeout, tty }) → { output, stderr, exit_code, log, truncated }, also for a non-zero exit; output is stdout up to 1 MiB and the log holds both streams. run(cmd).json() parses stdout, run(cmd).jsonErr() parses stderr. \`tty: true\` gives the command a pty (stdout and stdin are the terminal; stderr stays apart), for a program that refuses without one. sh(cmd, { check = true, ... }) → output, throws on a non-zero exit. json(cmd, opts) → run(cmd).json().
- fs: text(path) → raw file text; rows(path, from = 1, count = 200) → numbered window; write(path, content); glob(pattern); ls(path) → names.
- Text: lines(text) · page(text, from, count) · count(items, key?) → sorted [value, n] · unique · sum · median · p95.
- put(key, value) / get(key): JSON state across scripts. Above 64 KiB it spills to a file and returns that path; load()/store() stay for small values, at most 256 KiB each and 1 MiB together.
- tools.<tool>.<op>(args) calls a tool that takes an op or action: tools.github.pr_view({ pr: "12" }) is tools.github({ op: "pr_view", pr: "12" }).
- settle(promises) → each value, or "Error: …". mapLimit(items, n, fn). sleep(s). poll(fn, { every = 15, timeout = 600 }).
- job(cmd, { wait_on, wait_seconds }) → background shell job { job, status, log }; tools.shell({ action: "wait", job, wait_on }) waits, and you are woken when it exits.
A script with no \`timeout_ms\` is killed at ${DEFAULT_TIMEOUT_MS / 60_000} minutes; raise it on the first line with \`// @options: {"timeout_ms": N}\`.
A first line \`// @background\` runs the whole script in the background: the call returns at once and you are woken with its output. It holds one of two script workers until it ends.

The script is the program; a command runs one external program:
- One program per run(). Independent commands go in separate calls under settle(), so each keeps its own exit code and output and one failure does not hide the rest.
- Filter, count, sort, and join in JS, not with \`;\` chains or pipes into head, tail, grep, sort, awk, or jq. For a --json command, reach for .json()/json().
- Keep intermediate results in variables, or in put()/get() across scripts.
- Declared tools work here too. Use tools.github and tools.nix instead of the gh and nix commands they cover.
- Return only what you need to see.

\`\`\`js
const [log, status, top, readme] = await settle([
  sh("git log --oneline -20"),
  sh("git status --short"),
  tools.ls({ path: "." }),
  fs.text("README.md"),
]);
return { log, dirs: top.entries?.filter((e) => e.endsWith("/")), readme: page(readme, 1, 20) };
\`\`\`
\`\`\`js
const files = lines(await sh("git ls-files"));
return count(files, (f) => f.split("/").slice(0, 2).join("/")).slice(0, 30);
\`\`\`
\`\`\`js
const r = await run("npm test", { tail: 40, timeout: 600 });
if (r.exit_code === 0) return "tests pass";
const { lines: failures } = await tools.grep({ pattern: "FAIL|Error", path: r.log, context: 2 });
return { tail: r.output, failures: failures.map((l) => l.text) };
\`\`\``;

const GUIDELINE =
	"Run commands through codemode and write the work as a JS program: one external program per run(), independent commands in parallel with settle(), output filtered and joined in JS instead of pipes, `;` chains, or /tmp files.";

interface Schema {
	properties?: Record<string, { const?: unknown; enum?: unknown[]; anyOf?: { const?: unknown }[] }>;
}

/**
 * One line that gives each tool taking an `op` or `action` a method per value, so a script writes
 * tools.github.pr_view(args) for tools.github({ op: "pr_view", ...args }).
 */
export function opMethods(list: { name: string; parameters?: unknown }[]): string {
	const identifier = /^[A-Za-z_$][\w$]*$/;
	return list
		.flatMap(({ name, parameters }) => {
			const properties = (parameters as Schema | undefined)?.properties ?? {};
			const key = ["op", "action"].find((candidate) => candidate in properties);
			if (!key) return [];
			const field = properties[key];
			const values = [...(field?.enum ?? []), ...(field?.anyOf ?? []).map((option) => option.const)].filter((v): v is string => typeof v === "string" && identifier.test(v));
			const id = name.replace(/[^\w$]/g, "_");
			if (values.length === 0 || !identifier.test(id)) return [];
			const methods = values.map((value) => `tools.${id}.${value} = (a = {}) => tools.${id}({ ...a, ${key}: ${JSON.stringify(value)} });`).join(" ");
			return [`if (typeof tools.${id} === "function") { ${methods} }`];
		})
		.join(" ");
}

/** The script with an options line and the prelude around it. A default deadline is added when the script sets none. */
function withPrelude(code: string, spill = "", methods = ""): string {
	const options = /^\/\/ @options:[^\n]*\n?/.exec(code)?.[0] ?? "";
	const body = code.slice(options.length);
	const deadline = /timeout_ms/.test(code.slice(0, 300)) ? "" : `// @options: ${JSON.stringify({ timeout_ms: DEFAULT_TIMEOUT_MS })}\n`;
	return `${options}${deadline}${prelude(spill)} ${methods} {${body}\n}`;
}

/** The session's spill directory for values too big for the transcript, or "" when the session is unsaved. */
function spillDir(ctx: { sessionManager: { getSessionFile(): string | undefined } }): string {
	const file = ctx.sessionManager.getSessionFile();
	return file ? `${file.replace(/\.jsonl$/, "")}/spill` : "";
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
					// A codemode tool activated by name, as a subagent's --tools list does, stays callable and is listed here, not declared.
					const scriptOnly = loadout.declared.filter((tool) => loadout.getExposure(tool.name) === "codemode").map((tool) => tool.name);
					const view: ToolLoadout = {
						declared: loadout.declared.filter((tool) => !scriptOnly.includes(tool.name)),
						callable: loadout.callable,
						registered: loadout.registered,
						getExposure: (name) => loadout.getExposure(name),
						getNamespace: (name) => loadout.getNamespace(name),
						getPromptGuidelines: (name) => loadout.getPromptGuidelines(name),
					};
					const result = original.prepareLoadout?.(view);
					if (!result) return result;
					const description = result.descriptions?.[original.name];
					return {
						...result,
						...(description ? { descriptions: { ...result.descriptions, [original.name]: `${description}\n\n${HELPERS}` } } : {}),
						hiddenDeclarations: [...(result.hiddenDeclarations ?? []), ...scriptOnly],
					};
				}
			: undefined,
		renderResult: original.renderResult
			? (result, options, theme, context) => {
					// Nested errors keep the command's ANSI codes, which reset the tool row's background.
					const details = result.details as { calls?: { error?: string }[] } | undefined;
					const calls = details?.calls?.map((call) => (call.error ? { ...call, error: stripVTControlCharacters(call.error) } : call));
					return original.renderResult!(calls ? { ...result, details: { ...details, calls } } : result, options, theme, context);
				}
			: undefined,
		execute: async (id, params: { code: string }, signal, onUpdate, ctx) => {
			const background = /^\/\/ @background[^\n]*\n/.exec(params.code);
			const wake = (content: string, error: boolean) =>
				pi.sendMessage({ customType: "codemode-background", content, display: true, details: { error } }, { triggerTurn: true, deliverAs: "steer" });
			const report = (script: ReturnType<typeof original.execute>) =>
				void script.then(
					(result) => wake(`Background script ${id} finished:\n${result.content.map((part) => (part.type === "text" ? part.text : "")).join("")}`, Boolean(result.isError)),
					(error: Error) => wake(`Background script ${id} failed: ${error.message}`, true),
				);
			const spill = spillDir(ctx);
			const methods = opMethods(pi.getAllTools());
			if (!background) {
				const code = withPrelude(params.code, spill, methods);
				// A script moved to the background outlives its tool call, so only session shutdown cancels it then.
				const outcome = await untilInterrupt(id, signal, (own, attached) =>
					original.execute(id, { code }, AbortSignal.any([own, shutdown.signal]), (update) => {
						if (attached()) onUpdate?.(update);
					}, ctx),
				);
				if ("value" in outcome) return outcome.value;
				report(outcome.background);
				return { content: [{ type: "text", text: `The user interrupted; script ${id} moved to the background and you are woken with its result.` }], details: undefined };
			}
			// A background script outlives its tool call, so only session shutdown cancels it.
			const script = original.execute(id, { code: withPrelude(params.code.slice(background[0].length), spill, methods) }, shutdown.signal, undefined, ctx);
			inBackground(id, script);
			report(script);
			return { content: [{ type: "text", text: `Started script ${id} in the background; you are woken with its result.` }], details: undefined };
		},
	});
	const shutdown = new AbortController();
	pi.on("session_shutdown", () => shutdown.abort());
	registerInterrupt(pi);
}
