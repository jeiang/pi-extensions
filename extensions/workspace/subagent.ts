import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentToolResult, type ExtensionAPI, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

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
export function childArgs(agent: Agent, task: string, sessionDir: string | undefined): string[] {
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
		"--",
		task,
	];
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
	/** Detaches every foreground child, so a message the user sends while one runs reaches the model. */
	const steerable = new Set<() => void>();

	const acquire = async () => {
		while (active >= limit) {
			const { promise, resolve } = Promise.withResolvers<void>();
			waiting.push(resolve);
			await promise;
		}
		active++;
	};
	const release = () => {
		active--;
		waiting.shift()?.();
	};

	/** Runs one child to its end. Resolves with its final answer, or rejects with the reason and the stderr tail. */
	const run = async (agent: Agent, task: string, sessionDir: string | undefined, signal: AbortSignal | undefined, onProgress?: (line: string) => void) => {
		await acquire();
		const id = `sub${next++}`;
		try {
			if (signal?.aborted) throw new Error("Cancelled before the child started.");
			const cwd = options.cwd();
			const child = spawn("pi", childArgs(agent, task, sessionDir), { cwd, env: await options.env(cwd), stdio: ["ignore", "pipe", "pipe"] });
			const kill = () => void child.kill("SIGTERM");
			children.set(id, { id, agent: agent.name, kill });
			signal?.addEventListener("abort", kill, { once: true });

			let answer = "";
			let stop = "";
			let error = "";
			let stderr = "";
			let buffered = "";
			let tools = 0;
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
				const lines = (buffered + chunk).split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines) {
					let event: { type?: string; toolName?: string; message?: { role?: string; stopReason?: string; errorMessage?: string; content?: unknown } };
					try {
						event = JSON.parse(line);
					} catch {
						continue;
					}
					if (event.type === "tool_execution_start") onProgress?.(`${agent.name}: ${++tools} tool calls, now ${event.toolName ?? "?"}`);
					if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
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
			if (!exit && answer && stop !== "error" && stop !== "aborted") return answer;
			const reason = [exit, stop === "error" || stop === "aborted" ? `model ${stop}` : "", !answer ? "no answer" : ""].filter(Boolean).join(", ");
			throw new Error(
				[`${agent.name} failed (${reason}).`, error, stderr.trim() && `stderr:\n${stderr.trim()}`, sessionDir && `transcript: ${sessionDir}`]
					.filter(Boolean)
					.join("\n"),
			);
		} finally {
			children.delete(id);
			release();
		}
	};

	pi.on("session_shutdown", () => {
		for (const child of children.values()) child.kill();
	});

	pi.on("input", (event) => {
		if (event.streamingBehavior === "steer") for (const detach of steerable) detach();
	});

	const params = Type.Object({
		agent: Type.String({ description: `One of: ${agents.map((agent) => agent.name).join(", ")}.` }),
		task: Type.String({ description: "The whole assignment: the question, the file paths and facts you already have, and what to return." }),
		background: Type.Optional(Type.Boolean({ description: "Return at once; you are woken with the result." })),
	});
	const text = (value: string): AgentToolResult<undefined> => ({ content: [{ type: "text", text: value }], details: undefined });

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: `Run one read-only child agent in this session's directory and get its final answer. Children never edit files. Put the file paths and facts you already have in the task. The child starts with the project instructions and nothing else. For several children, make several calls in one message; at most ${limit} run at once and the rest wait. A message from the user moves a running child to the background.\nAgents:\n${agents.map((agent) => `- ${agent.name}: ${agent.description}`).join("\n")}`,
		promptSnippet: `Delegate to a read-only child agent (${agents.map((agent) => agent.name).join(", ")})`,
		parameters: params,
		exposure: "model-only",
		async execute(_id, input: Static<typeof params>, signal, onUpdate, ctx) {
			const agent = agents.find((candidate) => candidate.name === input.agent);
			if (!agent) throw new Error(`No agent "${input.agent}"; known: ${agents.map((candidate) => candidate.name).join(", ")}.`);
			const sessionFile = ctx.sessionManager.getSessionFile();
			const sessionDir = sessionFile ? join(ctx.sessionManager.getSessionDir(), "subagents", ctx.sessionManager.getSessionId()) : undefined;
			const report = (result: Promise<string>) =>
				void result.then(
					(answer) => wake(`Subagent ${agent.name} finished:\n${answer}`, false),
					(error: Error) => wake(`Subagent ${error.message}`, true),
				);
			const wake = (content: string, error: boolean) =>
				pi.sendMessage({ customType: "subagent", content, display: true, details: { error } }, { triggerTurn: true, deliverAs: "steer" });
			if (input.background) {
				// A background child outlives the tool call, so the call's signal does not cancel it.
				report(run(agent, input.task, sessionDir, undefined));
				return text(`Launched ${agent.name} in the background; you are woken with its result or its failure.`);
			}
			const controller = new AbortController();
			const cancel = () => controller.abort();
			if (signal?.aborted) cancel();
			signal?.addEventListener("abort", cancel, { once: true });
			let attached = true;
			const result = run(agent, input.task, sessionDir, controller.signal, (line) => {
				if (attached) onUpdate?.({ content: [{ type: "text", text: line }], details: undefined });
			});
			const steered = Promise.withResolvers<void>();
			steerable.add(steered.resolve);
			try {
				const answer = await Promise.race([result, steered.promise]);
				if (typeof answer === "string") return text(answer);
			} finally {
				attached = false;
				steerable.delete(steered.resolve);
				signal?.removeEventListener("abort", cancel);
			}
			report(result);
			return text(`The user sent a message; ${agent.name} moved to the background and you are woken with its result or its failure.`);
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
}
