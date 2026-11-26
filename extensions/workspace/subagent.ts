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

const DEFAULT_MAX_CONCURRENT = 3;
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

const clip = (text: string, limit: number) => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
};

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
					const summary = [call.input.command, call.input.pattern, pathsOf(call.input)[0], call.input.op, call.input.action].find((value) => typeof value === "string");
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

interface Child {
	id: string;
	agent: string;
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
	const config = existsSync(configFile) ? (JSON.parse(readFileSync(configFile, "utf8")) as { maxConcurrent?: number }) : {};
	let limit = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
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

	/** Runs one child to its end. `text` is its final answer, or on failure the reason, the stderr tail, and the session to resume; `usage` sums the child's model calls. */
	const run = async (
		agent: Agent,
		task: string,
		sessionDir: string | undefined,
		session: string,
		signal: AbortSignal | undefined,
		onProgress?: (line: string) => void,
	): Promise<{ text: string; failed: boolean; usage?: Usage }> => {
		await acquire();
		const id = `sub${next++}`;
		try {
			if (signal?.aborted) throw new Error("Cancelled before the child started.");
			const cwd = options.cwd();
			const child = spawn("pi", childArgs(agent, task, sessionDir, session), { cwd, env: await options.env(cwd), stdio: ["ignore", "pipe", "pipe"] });
			const kill = () => void child.kill("SIGTERM");
			children.set(id, { id, agent: agent.name, kill });
			signal?.addEventListener("abort", kill, { once: true });

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
					if (event.type === "tool_execution_start") onProgress?.(`${agent.name}: ${++tools} tool calls, now ${event.toolName ?? "?"}`);
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
			const reason = [exit, stop === "error" || stop === "aborted" ? `model ${stop}` : "", !answer ? "no answer" : ""].filter(Boolean).join(", ");
			const text = [
				`${agent.name} failed (${reason}).`,
				error,
				stderr.trim() && `stderr:\n${stderr.trim()}`,
				// The child's transcript outlives the failure; its id is the handle to continue it.
				sessionDir && `session ${session}; resume it with { agent: "${agent.name}", resume: "${session}" }`,
			]
				.filter(Boolean)
				.join("\n");
			return { text, failed: true, usage };
		} finally {
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
		agent: Type.String({ description: `One of: ${agents.map((agent) => agent.name).join(", ")}.` }),
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
	});
	const outputSchema = Type.Object({
		agent: Type.String(),
		status: Type.String({ description: "done, failed, or background (you are woken with the result later)" }),
		answer: Type.String({ description: "The child's final answer, or why it failed." }),
		session: Type.String({ description: "The child's session id; pass it back as resume to continue that child." }),
	});
	const text = (
		value: string,
		agent: string,
		status: "done" | "failed" | "background",
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
		description: `Run one read-only child agent in this session's directory and get its final answer. Children never edit files. Put the file paths and facts you already have in the task. The child starts with the project instructions and nothing else. For several children, pass briefs in one call (or make several calls, or Promise.all in a script); at most ${limit} run at once and the rest wait. If the user interrupts, a running child moves to the background. A failed or aborted child names its session; pass that id as resume, with the same agent, to continue it where it stopped. Scripts get { agent, status, answer, session }.\nAgents:\n${agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n")}`,
		promptSnippet: `Delegate to a read-only child agent (${agents.map((agent) => agent.name).join(", ")})`,
		parameters: params,
		outputSchema,
		async execute(id, input: Static<typeof params>, signal, onUpdate, ctx) {
			if (input.briefs?.length) {
				const sessionFile = ctx.sessionManager.getSessionFile();
				const sessionDir = sessionFile ? join(ctx.sessionManager.getSessionDir(), "subagents", ctx.sessionManager.getSessionId()) : undefined;
				const results = await Promise.all(
					input.briefs.map(async (brief) => {
						const found = agents.find((candidate) => candidate.name === brief.agent);
						if (!found) throw new Error(`No agent "${brief.agent}"; known: ${agents.map((candidate) => candidate.name).join(", ")}.`);
						const session = randomUUID();
						const outcome = await run(found, brief.task, sessionDir, session, signal);
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
			const agent = agents.find((candidate) => candidate.name === input.agent);
			if (!agent) throw new Error(`No agent "${input.agent}"; known: ${agents.map((candidate) => candidate.name).join(", ")}.`);
			const task = input.task?.trim() || (input.resume ? "You were interrupted mid-task. Continue from where you stopped and give your final answer." : "");
			if (!task) throw new Error("subagent needs a task, unless resume names a session to continue.");
			const sessionFile = ctx.sessionManager.getSessionFile();
			const sessionDir = sessionFile ? join(ctx.sessionManager.getSessionDir(), "subagents", ctx.sessionManager.getSessionId()) : undefined;
			if (input.resume && !(sessionDir && sessionExists(sessionDir, input.resume)))
				throw new Error(`No child session ${input.resume} to resume; children live in ${sessionDir ?? "no directory, because this session is unsaved"}.`);
			const session = input.resume ?? randomUUID();
			const report = (result: ReturnType<typeof run>) =>
				void result.then(
					(done) => wake(done.failed ? `Subagent (session ${session}) ${done.text}` : `Subagent ${agent.name} finished (session ${session}):\n${done.text}`, done.failed, done.usage),
					(error: Error) => wake(`Subagent ${agent.name} failed (session ${session}): ${error.message}`, true, undefined),
				);
			const wake = (content: string, error: boolean, usage: Usage | undefined) => {
				if (closed) return;
				pi.sendMessage({ customType: "subagent", content, display: true, details: { error, usage } }, { triggerTurn: true, deliverAs: "steer" });
			};
			if (input.background) {
				// A background child outlives the tool call, so the call's signal does not cancel it.
				report(run(agent, task, sessionDir, session, undefined));
				return text(`Launched ${agent.name} in the background as session ${session}; you are woken with its result or its failure.`, agent.name, "background", session);
			}
			const outcome = await untilInterrupt(id, signal, (childSignal, attached) =>
				run(agent, task, sessionDir, session, childSignal, (line) => {
					if (attached()) onUpdate?.({ content: [{ type: "text", text: line }], details: undefined });
				}),
			);
			if ("value" in outcome) return text(outcome.value.text, agent.name, outcome.value.failed ? "failed" : "done", session, outcome.value.usage);
			report(outcome.background);
			return text(
				`The user interrupted; ${agent.name} moved to the background as session ${session} and you are woken with its result or its failure.`,
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
			const running = [...children.values()].map((child) => `${child.id} ${child.agent}`).join(", ") || "none";
			ctx.ui.notify(`Subagents: at most ${limit} at once; running: ${running}; waiting: ${waiting.length}`, "info");
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
				const outcome = await run(scout, sessionDigest(ctx.sessionManager.getBranch() as Entry[], question), undefined, randomUUID(), undefined);
				pi.appendEntry("btw", { question, answer: outcome.text });
				ctx.ui.notify(outcome.text, outcome.failed ? "error" : "info");
			} finally {
				ctx.ui.setStatus("btw", undefined);
			}
		},
	});
}
