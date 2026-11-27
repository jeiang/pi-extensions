import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import { type AgentToolResult, type ExtensionAPI, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { lastCheckpoint } from "../checkpoint/index.ts";
import { addUsage } from "../footer/cost.ts";
import { untilInterrupt } from "./interrupt.ts";
import { claimed, trackJob } from "./jobs.ts";

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_TIMEOUT_S = 30 * 60;
const STDERR_TAIL_LINES = 20;

export interface Agent {
	name: string;
	description: string;
	model?: string;
	thinking?: string;
	tools?: string;
	extensions: string[];
	inheritProjectContext: boolean;
	prompt: string;
}

const list = (value: unknown): string[] =>
	(Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []).flatMap((item) =>
		typeof item === "string" && item.trim() ? [item.trim()] : [],
	);

/** Agent definitions in `dir`: Markdown files whose frontmatter names the model, tools, and extensions of the child. */
export function loadAgents(dir: string): Agent[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.flatMap((file): Agent[] => {
			const { frontmatter, body } = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
			const text = (key: string) => (typeof frontmatter[key] === "string" ? frontmatter[key] : undefined);
			const name = text("name");
			if (!name) return [];
			return [
				{
					name,
					description: text("description") ?? "",
					model: text("model"),
					thinking: text("thinking"),
					tools: list(frontmatter.tools).join(",") || undefined,
					extensions: list(frontmatter.extensions).map((path) => path.replace(/^~(?=\/)/, homedir())),
					inheritProjectContext: frontmatter.inheritProjectContext !== false,
					prompt: body.trim(),
				},
			];
		});
}

/** Arguments of the `pi` child for `agent`. `subagent` stays out of the child, so children cannot nest. */
export function childArgs(agent: Agent, task: string, sessionDir: string | undefined, sessionId?: string): string[] {
	return [
		"--mode",
		"json",
		"-p",
		...(agent.model ? ["--model", agent.model] : []),
		...(agent.thinking ? ["--thinking", agent.thinking] : []),
		...(agent.tools ? ["--tools", agent.tools] : ["--exclude-tools", "subagent"]),
		// Without -ne the child would discover every installed extension, the advisor included.
		"-ne",
		...agent.extensions.flatMap((path) => ["-e", path]),
		...(agent.prompt ? ["--append-system-prompt", agent.prompt] : []),
		...(agent.inheritProjectContext ? [] : ["-nc"]),
		...(sessionDir ? ["--session-dir", sessionDir] : ["--no-session"]),
		// pi reopens the existing transcript for this id, so a resumed child continues where it stopped.
		...(sessionId ? ["--session-id", sessionId] : []),
		"--",
		task,
	];
}
/** Whether `dir` holds the transcript of child session `id`; pi names it `<timestamp>_<id>.jsonl`. */
export function sessionExists(dir: string, id: string): boolean {
	return existsSync(dir) && readdirSync(dir).some((file) => file.endsWith(`_${id}.jsonl`));
}

/** A session entry, as far as the digest reads it. */
interface Entry {
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role?: string; content?: unknown };
}

const textOf = (content: unknown): string =>
	typeof content === "string"
		? content
		: Array.isArray(content)
			? content.flatMap((part) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? [part.text] : [])).join("\n")
			: "";

const callsOf = (content: unknown): { name: string; input: Record<string, unknown> }[] =>
	Array.isArray(content)
		? content.flatMap((part) =>
				part && typeof part === "object" && (part.type === "toolCall" || part.type === "tool-call" || part.type === "tool_use")
					? [{ name: String(part.name ?? "?"), input: (part.input ?? part.arguments ?? {}) as Record<string, unknown> }]
					: [],
			)
		: [];

const pathsOf = (input: Record<string, unknown>): string[] => [
	...(typeof input.path === "string" ? [input.path] : []),
	...(Array.isArray(input.paths) ? input.paths.filter((path): path is string => typeof path === "string") : []),
	...(typeof input.input === "string" ? [...input.input.matchAll(/\[([^\]#\n]+)#/g)].map((match) => match[1] ?? "") : []),
];

/** The argument that names what a tool call was about, for one line of a digest. */
const summaryOf = (input: Record<string, unknown>): string | undefined =>
	[input.command, input.pattern, pathsOf(input)[0], input.op, input.action].find((value) => typeof value === "string");

const clip = (text: string, limit: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

const elapsed = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`);

/** Where the session stands, for a child that cannot see its transcript. */
export function sessionDigest(entries: Entry[], question: string): string {
	const parts: string[] = [];
	const checkpoint = lastCheckpoint({ getBranch: () => entries });
	if (checkpoint) parts.push(`Checkpoint:\n${checkpoint.state}`);
	const requests = entries.flatMap((entry) => (entry.type === "message" && entry.message?.role === "user" ? [textOf(entry.message.content)] : [])).filter(Boolean);
	if (requests.length > 0) parts.push(`Last request from the user:\n${clip(requests.at(-1) ?? "", 600)}`);
	const calls = entries.flatMap((entry) => (entry.type === "message" && entry.message?.role === "assistant" ? callsOf(entry.message.content) : []));
	if (calls.length > 0) {
		parts.push(
			`Recent tool calls:\n${calls
				.slice(-12)
				.map((call) => {
					const summary = summaryOf(call.input);
					return `${call.name} ${clip(String(summary ?? JSON.stringify(call.input)), 100)}`;
				})
				.join("\n")}`,
		);
	}
	const files = [...new Set(calls.flatMap((call) => pathsOf(call.input)))].slice(-15);
	if (files.length > 0) parts.push(`Files touched:\n${files.join("\n")}`);
	parts.push(`Answer this from the working directory. You cannot see the session's transcript.\n\n${question}`);
	return parts.join("\n\n");
}

/** What child session `id` did, from its transcript: the last assistant text, tool calls, and results. */
export function sessionTail(dir: string, id: string, limit = 20): string[] {
	if (!existsSync(dir)) return [];
	const file = readdirSync(dir).find((name) => name.endsWith(`_${id}.jsonl`));
	if (!file) return [];
	const out: string[] = [];
	for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
		let entry: Entry;
		try {
			entry = JSON.parse(line) as Entry;
		} catch {
			continue;
		}
		const message = entry.message;
		if (entry.type !== "message" || !message) continue;
		if (message.role === "assistant") {
			const text = clip(textOf(message.content), 200);
			if (text) out.push(`say ${text}`);
			for (const call of callsOf(message.content)) out.push(`${call.name} ${clip(String(summaryOf(call.input) ?? JSON.stringify(call.input)), 140)}`);
		} else if (message.role === "toolResult") {
			const text = clip(textOf(message.content), 160);
			if (text) out.push(`  → ${text}`);
		}
	}
	return out.slice(-Math.max(1, limit));
}

interface Child {
	id: string;
	agent: string;
	session: string;
	started: number;
	/** The last progress lines this child reported. */
	progress: string[];
	kill: () => void;
}

export interface SubagentOptions {
	cwd: () => string;
	env: (cwd: string) => Promise<NodeJS.ProcessEnv>;
}

export function registerSubagent(pi: ExtensionAPI, options: SubagentOptions) {
	const agents = loadAgents(join(getAgentDir(), "agents"));
	if (agents.length === 0) return;

	const configFile = join(getAgentDir(), "subagent.json");
	const config = existsSync(configFile) ? (JSON.parse(readFileSync(configFile, "utf8")) as { maxConcurrent?: number; timeoutSeconds?: number }) : {};
	let limit = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
	const timeoutSeconds = config.timeoutSeconds && config.timeoutSeconds > 0 ? config.timeoutSeconds : DEFAULT_TIMEOUT_S;
	let active = 0;
	let next = 1;
	const waiting: (() => void)[] = [];
	const children = new Map<string, Child>();
	// A child queued behind the limit must not spawn into a session that is closing.
	let closed = false;

	const acquire = async () => {
		while (active >= limit) {
			const { promise, resolve } = Promise.withResolvers<void>();
			waiting.push(resolve);
			await promise;
		}
		if (closed) throw new Error("The session is shutting down.");
		active++;
	};
	const release = () => {
		active--;
		waiting.shift()?.();
	};

	/** Runs one child to its end. `text` is its final answer, or on failure the reason, what it last did, and the session to resume; `usage` sums its model calls. */
	const run = async (
		agent: Agent,
		task: string,
		sessionDir: string | undefined,
		session: string,
		signal: AbortSignal | undefined,
		onProgress?: (line: string) => void,
		timeout = timeoutSeconds,
	): Promise<{ text: string; failed: boolean; usage?: Usage }> => {
		await acquire();
		const id = `sub${next++}`;
		let timer: NodeJS.Timeout | undefined;
		try {
			if (signal?.aborted) throw new Error("Cancelled before the child started.");
			const cwd = options.cwd();
			const child = spawn("pi", childArgs(agent, task, sessionDir, session), { cwd, env: await options.env(cwd), stdio: ["ignore", "pipe", "pipe"] });
			const kill = () => void child.kill("SIGTERM");
			const record: Child = { id, agent: agent.name, session, started: Date.now(), progress: [], kill };
			children.set(id, record);
			signal?.addEventListener("abort", kill, { once: true });
			let timedOut = false;
			if (timeout > 0) {
				timer = setTimeout(() => {
					timedOut = true;
					record.progress.push(`${agent.name}: no result after ${elapsed(timeout * 1000)}; stopping`);
					kill();
				}, timeout * 1000);
			}

			let answer = "";
			let stop = "";
			let error = "";
			let stderr = "";
			let buffered = "";
			let tools = 0;
			let usage: Usage | undefined;
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
				const lines = (buffered + chunk).split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines) {
					let event: { type?: string; toolName?: string; message?: { role?: string; stopReason?: string; errorMessage?: string; content?: unknown; usage?: Usage } };
					try {
						event = JSON.parse(line);
					} catch {
						continue;
					}
					if (event.type === "tool_execution_start") {
						const line = `${agent.name}: ${++tools} tool calls, now ${event.toolName ?? "?"}`;
						record.progress.push(line);
						if (record.progress.length > 20) record.progress.shift();
						onProgress?.(line);
					}
					if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
					usage = addUsage(usage, event.message.usage);
					const parts = Array.isArray(event.message.content) ? (event.message.content as { type?: string; text?: string }[]) : [];
					answer = parts.flatMap((part) => (part.type === "text" && part.text ? [part.text] : [])).join("\n");
					stop = event.message.stopReason ?? "";
					error = event.message.errorMessage ?? "";
				}
			});
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
				stderr = (stderr + chunk).split("\n").slice(-STDERR_TAIL_LINES).join("\n");
			});
			const exited = Promise.withResolvers<string>();
			child.on("error", (spawnError) => exited.resolve(spawnError.message));
			child.on("close", (code, killedBy) => exited.resolve(code === 0 ? "" : killedBy ? `killed by ${killedBy}` : `exit ${code}`));
			const exit = await exited.promise;
			signal?.removeEventListener("abort", kill);
			if (!exit && answer && stop !== "error" && stop !== "aborted") return { text: answer, failed: false, usage };
			const failure = timedOut ? `timed out after ${timeout}s` : exit;
			const reason = [failure, stop === "error" || stop === "aborted" ? `model ${stop}` : "", !answer ? "no answer" : ""].filter(Boolean).join(", ");
			const text = [
				`${agent.name} failed (${reason}).`,
				error,
				stderr.trim() && `stderr:\n${stderr.trim()}`,
				record.progress.length > 0 && `Last activity:\n${record.progress.slice(-3).join("\n")}`,
				// The child's transcript outlives the failure; its id is the handle to continue it.
				sessionDir && `session ${session}; resume it with { agent: "${agent.name}", resume: "${session}" }`,
			]
				.filter(Boolean)
				.join("\n");
			return { text, failed: true, usage };
		} finally {
			clearTimeout(timer);
			children.delete(id);
			release();
		}
	};

	pi.on("session_shutdown", () => {
		closed = true;
		// The waiters wake, see `closed`, and stop instead of taking a freed slot.
		for (const resume of waiting.splice(0)) resume();
		for (const child of children.values()) child.kill();
	});

	const params = Type.Object({
		agent: Type.Optional(Type.String({ description: `One of: ${agents.map((agent) => agent.name).join(", ")}.` })),
		task: Type.Optional(
			Type.String({ description: "The whole assignment: the question, the file paths and facts you already have, and what to return. Leave it out when resume is given." }),
		),
		resume: Type.Optional(
			Type.String({ description: "Session id of an earlier child of the same agent, to continue it with its transcript instead of starting fresh." }),
		),
		background: Type.Optional(Type.Boolean({ description: "Return at once; you are woken with the result." })),
		briefs: Type.Optional(
			Type.Array(Type.Object({ agent: Type.String(), task: Type.String() }), {
				description: "Several children in one call, each at most maxConcurrent at a time; returns one section per brief and fails if any child failed.",
			}),
		),
		action: Type.Optional(
			Type.Union([Type.Literal("status"), Type.Literal("kill")], {
				description: "status: list running children, or with session show that child's progress and transcript tail. kill: stop a running child by session.",
			}),
		),
		session: Type.Optional(Type.String({ description: "status, kill: the child session id from its launch or a previous status." })),
		timeout: Type.Optional(Type.Number({ description: `Seconds before a child is stopped; 0 disables it. Default ${timeoutSeconds}.` })),
	});
	const outputSchema = Type.Object({
		agent: Type.String(),
		status: Type.String({ description: "done, failed, running, or background (you are woken with the result later)" }),
		answer: Type.String({ description: "The child's final answer, why it failed, or its progress." }),
		session: Type.String({ description: "The child's session id; pass it back as resume to continue that child." }),
	});
	const text = (
		value: string,
		agent: string,
		status: "done" | "failed" | "running" | "background",
		session: string,
		usage?: Usage,
	): AgentToolResult<undefined> & { structuredContent: Static<typeof outputSchema> } => ({
		content: [{ type: "text", text: value }],
		details: undefined,
		usage,
		isError: status === "failed",
		structuredContent: { agent, status, answer: status === "background" ? "" : value, session },
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: `Run one read-only child agent in this session's directory and get its final answer. Children never edit files. Put the file paths and facts you already have in the task. The child starts with the project instructions and nothing else. For several children, pass briefs in one call (or make several calls, or Promise.all in a script); at most ${limit} run at once and the rest wait. If the user interrupts, a running child moves to the background. A failed, timed-out, or aborted child names its session and what it last did; pass the session as resume, with the same agent, to continue it where it stopped. A child is stopped after ${timeoutSeconds}s (pass timeout: 0 to disable), so a stuck one wakes you instead of holding a slot. status lists running children, or with session shows a child's progress and transcript tail; kill stops one by session. Scripts get { agent, status, answer, session }.\nAgents:\n${agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n")}`,
		promptSnippet: `Delegate to a read-only child agent (${agents.map((agent) => agent.name).join(", ")})`,
		parameters: params,
		outputSchema,
		async execute(id, input: Static<typeof params>, signal, onUpdate, ctx) {
			const sessionFile = ctx.sessionManager.getSessionFile();
			const sessionDir = sessionFile ? join(ctx.sessionManager.getSessionDir(), "subagents", ctx.sessionManager.getSessionId()) : undefined;
			const running = [...children.values()];
			if (input.action === "kill") {
				if (!input.session) throw new Error("kill needs the child's session id; status lists them.");
				const target = running.find((child) => child.session === input.session);
				if (!target) throw new Error(`No running child session ${input.session}.`);
				target.kill();
				return text(`Stopping ${target.agent} (session ${input.session}); its failure wakes you with what it last did and the session to resume.`, target.agent, "done", input.session);
			}
			if (input.action === "status") {
				if (!input.session) {
					const rows = running.map((child) => `${child.id} ${child.agent} session ${child.session} ${elapsed(Date.now() - child.started)}: ${child.progress.at(-1) ?? "starting"}`);
					return text(rows.join("\n") || "No subagents running.", "", "done", "");
				}
				const child = running.find((entry) => entry.session === input.session);
				const tail = sessionDir ? sessionTail(sessionDir, input.session) : [];
				const head = child
					? `${child.agent} ${child.id} running ${elapsed(Date.now() - child.started)}: ${child.progress.at(-1) ?? "starting"}`
					: `No running child for session ${input.session}; its transcript's last activity:`;
				return text([head, tail.length > 0 ? tail.join("\n") : "(no transcript for this session)"].join("\n"), child?.agent ?? "", child ? "running" : "done", input.session);
			}
			if (input.briefs?.length) {
				const results = await Promise.all(
					input.briefs.map(async (brief) => {
						const found = agents.find((candidate) => candidate.name === brief.agent);
						if (!found) throw new Error(`No agent "${brief.agent}"; known: ${agents.map((candidate) => candidate.name).join(", ")}.`);
						const session = randomUUID();
						const outcome = await run(found, brief.task, sessionDir, session, signal, undefined, input.timeout);
						return {
							failed: outcome.failed,
							usage: outcome.usage,
							text: `${outcome.failed ? "FAILED" : "DONE"} ${brief.agent} (session ${session}):\n${outcome.text}`,
						};
					}),
				);
				const answer = results.map((result) => result.text).join("\n\n");
				const failed = results.some((result) => result.failed);
				return {
					content: [{ type: "text" as const, text: answer }],
					details: undefined,
					isError: failed,
					usage: results.reduce<Usage | undefined>((total, result) => addUsage(total, result.usage), undefined),
					structuredContent: { agent: "fan-out", status: failed ? "failed" : "done", answer, session: "" },
				};
			}
			if (!input.agent) throw new Error(`subagent needs an agent; known: ${agents.map((candidate) => candidate.name).join(", ")}.`);
			const agent = agents.find((candidate) => candidate.name === input.agent);
			if (!agent) throw new Error(`No agent "${input.agent}"; known: ${agents.map((candidate) => candidate.name).join(", ")}.`);
			const task = input.task?.trim() || (input.resume ? "You were interrupted mid-task. Continue from where you stopped and give your final answer." : "");
			if (!task) throw new Error("subagent needs a task, unless resume names a session to continue.");
			if (input.resume && !(sessionDir && sessionExists(sessionDir, input.resume)))
				throw new Error(`No child session ${input.resume} to resume; children live in ${sessionDir ?? "no directory, because this session is unsaved"}.`);
			const session = input.resume ?? randomUUID();
			const report = (result: ReturnType<typeof run>) => {
				const kill = () => [...children.values()].find((child) => child.session === session)?.kill();
				trackJob(session, "subagent", `${agent.name}: ${task.split("\n")[0]?.slice(0, 80)}`, result, kill);
				void result.then(
					(done) => wake(done.failed ? `Subagent (session ${session}) ${done.text}` : `Subagent ${agent.name} finished (session ${session}):\n${done.text}`, done.failed, done.usage),
					(error: Error) => wake(`Subagent ${agent.name} failed (session ${session}): ${error.message}`, true, undefined),
				);
			};
			// The wake waits a moment, so a job wait that returned the result claims it first.
			const wake = (content: string, error: boolean, usage: Usage | undefined) =>
				setTimeout(() => {
					if (closed || claimed(session)) return;
					pi.sendMessage({ customType: "subagent", content, display: true, details: { error, usage } }, { triggerTurn: true, deliverAs: "steer" });
				}, 200);
			if (input.background) {
				// A background child outlives the tool call, so the call's signal does not cancel it.
				report(run(agent, task, sessionDir, session, undefined, undefined, input.timeout));
				return text(
					`Launched ${agent.name} in the background as session ${session}; status with { action: "status", session: "${session}" } shows what it is doing, job waits on it as ${session}, kill stops it, and you are woken with its result or failure.`,
					agent.name,
					"background",
					session,
				);
			}
			const outcome = await untilInterrupt(id, signal, (childSignal, attached) =>
				run(agent, task, sessionDir, session, childSignal, (line) => {
					if (attached()) onUpdate?.({ content: [{ type: "text", text: line }], details: undefined });
				}, input.timeout),
			);
			if ("value" in outcome) return text(outcome.value.text, agent.name, outcome.value.failed ? "failed" : "done", session, outcome.value.usage);
			report(outcome.background);
			return text(
				`The user interrupted; ${agent.name} moved to the background as session ${session}. status with { action: "status", session: "${session}" } shows what it is doing, kill stops it, and you are woken with its result or failure.`,
				agent.name,
				"background",
				session,
			);
		},
	});

	pi.registerCommand("subagents", {
		description: "Show running subagents, or set how many run at once for this session: /subagents <n>",
		handler: async (args, ctx) => {
			const wanted = Number.parseInt(args.trim(), 10);
			if (wanted > 0) {
				limit = wanted;
				for (const resume of waiting.splice(0)) resume();
			}
			const running = [...children.values()].map((child) => `${child.id} ${child.agent} ${child.session} ${elapsed(Date.now() - child.started)}: ${child.progress.at(-1) ?? "starting"}`).join("\n") || "none";
			ctx.ui.notify(`Subagents: at most ${limit} at once, timeout ${timeoutSeconds}s; running:\n${running}\nwaiting: ${waiting.length}`, "info");
		},
	});

	pi.registerCommand("btw", {
		description: "Ask a side question about this session's state. It runs on a small model in a throwaway session, and nothing it reads or says enters this conversation.",
		handler: async (args, ctx) => {
			const question = args.trim();
			if (!question) return ctx.ui.notify("Usage: /btw <question>", "error");
			const scout = agents.find((candidate) => candidate.name === "btw");
			if (!scout) return ctx.ui.notify("No btw agent in the agents directory.", "error");
			ctx.ui.setStatus("btw", "thinking");
			try {
				const outcome = await run(scout, sessionDigest(ctx.sessionManager.getBranch() as Entry[], question), undefined, randomUUID(), undefined, undefined, 120);
				pi.appendEntry("btw", { question, answer: outcome.text });
				ctx.ui.notify(outcome.text, outcome.failed ? "error" : "info");
			} finally {
				ctx.ui.setStatus("btw", undefined);
			}
		},
	});
}
