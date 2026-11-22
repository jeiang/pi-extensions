import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionToolContext,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { onInterrupt } from "./interrupt.ts";

const DEFAULT_TIMEOUT_S = 120;
const TAIL_LINES = 30;
const MAX_WAKES = 5;
/** pi's limit on the `output` codemode scripts get from `bash`. */
const STRUCTURED_MAX_BYTES = 1024 * 1024;

interface Job {
	id: string;
	command: string;
	log: string;
	started: number;
	ended?: number;
	exitCode?: number | null;
	status: "running" | "exited" | "killed" | "failed";
	controller: AbortController;
	/** Byte offset `read` has returned up to. */
	cursor: number;
	/** `overwrite`: the line replaces the one before it, as after a carriage return. */
	listeners: Set<(line: string, overwrite: boolean) => void>;
	done: Promise<void>;
}

export const cwdParam = Type.Optional(
	Type.String({
		description: "Directory to run in, such as a worktree of another repository; an absolute path, or relative to the session directory. Loads that directory's devshell.",
	}),
);

const params = Type.Object({
	cwd: cwdParam,
	command: Type.Optional(Type.String({ description: "Shell command (bash). Runs inside the repository's devshell." })),
	timeout: Type.Optional(
		Type.Number({ description: `Seconds before a foreground command moves to the background (default ${DEFAULT_TIMEOUT_S}). It is not killed.` }),
	),
	background: Type.Optional(Type.Boolean({ description: "Start as a background job and return its id." })),
	wait_on: Type.Optional(
		Type.String({ description: "Regex: return as soon as an output line matches; later matching lines wake you while the job runs." }),
	),
	wait_seconds: Type.Optional(Type.Number({ description: "Return after this many seconds even if the job still runs." })),
	action: Type.Optional(
		Type.Union([Type.Literal("status"), Type.Literal("read"), Type.Literal("wait"), Type.Literal("kill")], {
			description: "Act on jobs instead of running a command: status lists jobs; read returns new output; wait blocks like wait_on/wait_seconds or until exit; kill stops it.",
		}),
	),
	job: Type.Optional(Type.String({ description: "Job id for read, wait, kill." })),
});

type Params = Static<typeof params>;

const text = (value: string): AgentToolResult<undefined> => ({ content: [{ type: "text", text: value }], details: undefined });

const duration = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`);

function tail(output: string, lines = TAIL_LINES): string {
	return output.split("\n").slice(-lines).join("\n");
}

const BAR_CELLS = 24;
const STEP = /\[(\d+)\/(\d+)\]|\b(\d+) of (\d+)\b|(\d{1,3}(?:\.\d+)?)%/;

/** A bar for a line that reports a build step or a percentage (`[3/12]`, `3 of 12`, `45%`). */
export function progressBar(line: string): string | undefined {
	const match = line.match(STEP);
	if (!match) return undefined;
	const fraction = match[5] === undefined ? Number(match[1] ?? match[3]) / Number(match[2] ?? match[4]) : Number(match[5]) / 100;
	if (!(fraction >= 0 && fraction <= 1)) return undefined;
	const filled = Math.round(fraction * BAR_CELLS);
	return `${"█".repeat(filled)}${"░".repeat(BAR_CELLS - filled)} ${Math.round(fraction * 100)}%`;
}

function readLog(job: Job, from = 0): string {
	const buffer = readFileSync(job.log);
	return buffer.subarray(from).toString("utf8");
}

const SHELL_META = /[|;&<>`$(){}*?\n]/;
const LEVEL_FLAGS: Record<string, "ignoreCase" | "literal" | "skip"> = {
	"-i": "ignoreCase",
	"--ignore-case": "ignoreCase",
	"-F": "literal",
	"--fixed-strings": "literal",
	"-n": "skip",
	"--line-number": "skip",
	"-r": "skip",
	"-R": "skip",
	"-E": "skip",
	"--no-heading": "skip",
};

function tokenize(command: string): string[] | undefined {
	const tokens: string[] = [];
	const re = /\s*(?:'([^']*)'|"([^"\\$`]*)"|([^\s'"]+))/gy;
	let match: RegExpExecArray | null;
	let consumed = 0;
	while ((match = re.exec(command)) !== null) {
		if (match[0].trim() === "") break;
		tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
		consumed = re.lastIndex;
	}
	return command.slice(consumed).trim() === "" ? tokens : undefined;
}

/** Arguments for the grep tool when `command` is one plain `rg` or `grep` call it can serve. */
export function grepRoute(command: string): Record<string, unknown> | undefined {
	const unquoted = command.replace(/'[^']*'|"[^"]*"/g, "");
	if (SHELL_META.test(unquoted)) return undefined;
	const tokens = tokenize(command.trim())?.flatMap((token) =>
		/^-[a-zA-Z]{2,}$/.test(token) ? [...token.slice(1)].map((letter) => `-${letter}`) : [token],
	);
	if (!tokens || (tokens[0] !== "rg" && tokens[0] !== "grep")) return undefined;
	const args: Record<string, unknown> = {};
	const positional: string[] = [];
	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i] ?? "";
		const flag = LEVEL_FLAGS[token];
		if (flag === "skip") continue;
		if (flag) args[flag] = true;
		else if (token === "-g" || token === "--glob" || token === "--include") args.glob = tokens[++i];
		else if (token.startsWith("--include=") || token.startsWith("--glob=")) args.glob = token.slice(token.indexOf("=") + 1);
		else if (token === "-C" || token === "--context") args.context = Number(tokens[++i]);
		else if (token.startsWith("-")) return undefined;
		else positional.push(token);
	}
	const stdin = tokens[0] === "grep" && positional.length < 2 && !tokens.includes("-r") && !tokens.includes("-R");
	if (positional.length < 1 || positional.length > 2 || stdin) {
		return undefined;
	}
	args.pattern = positional[0];
	if (positional[1]) args.path = positional[1];
	return args;
}

export interface ShellOptions {
	/** The session directory, or `dir` resolved against it. */
	cwd: (dir?: string) => string;
	env: (cwd: string) => Promise<NodeJS.ProcessEnv>;
	/** Why the devshell for `cwd` failed to load, if it did. */
	devshellError: (cwd: string) => string | undefined;
}

export function registerShell(pi: ExtensionAPI, options: ShellOptions) {
	const jobs = new Map<string, Job>();
	const ops = createLocalBashOperations();
	const logDir = join(tmpdir(), "pi-shell");
	let next = 1;
	const dirOf = (input?: string) => {
		const dir = options.cwd(input);
		if (!existsSync(dir)) throw new Error(`No directory ${dir}`);
		return dir;
	};
	/** The exit result of a foreground command; the job is done and forgotten. */
	const finished = (job: Job) => {
		jobs.delete(job.id);
		const truncated = truncateTail(readLog(job));
		const note = truncated.truncated ? `\n[output truncated, full log: ${job.log}]` : "";
		const status = job.status === "exited" ? (job.exitCode === 0 ? "" : `\nCommand exited with code ${job.exitCode}`) : `\n[${job.status}]`;
		return { content: [{ type: "text" as const, text: `${truncated.content}${note}${status}`.trim() || "(no output)" }], details: undefined, isError: job.status !== "exited" || job.exitCode !== 0 };
	};

	const wake = (content: string, error = false) =>
		pi.sendMessage({ customType: "shell-job", content, display: true, details: { error } }, { triggerTurn: true, deliverAs: "steer" });

	const summary = (job: Job) => {
		const state = job.status === "exited" ? `exit ${job.exitCode}` : job.status;
		return `${job.id} [${state}, ${duration((job.ended ?? Date.now()) - job.started)}] ${job.command}\nlog: ${job.log}`;
	};

	const start = async (command: string, cwd: string): Promise<Job> => {
		mkdirSync(logDir, { recursive: true });
		const id = `job${next++}`;
		const log = join(logDir, `${process.pid}-${id}.log`);
		const env = await options.env(cwd);
		const devshellError = options.devshellError(cwd);
		writeFileSync(log, devshellError ? `[shell] devshell failed, ran without it:\n${devshellError}\n` : "");
		const controller = new AbortController();
		const listeners: Job["listeners"] = new Set();
		let partial = "";
		let overwrite = false;
		const emit = (line: string) => {
			// A bare carriage return redraws nothing.
			if (overwrite && line === "") return;
			for (const listener of listeners) listener(line, overwrite);
		};
		const job: Job = { id, command, log, started: Date.now(), status: "running", controller, cursor: 0, listeners, done: Promise.resolve() };
		job.done = ops
			.exec(command, cwd, {
				signal: controller.signal,
				env: { ...env, PYTHONUNBUFFERED: "1" },
				onData: (data) => {
					appendFileSync(log, data);
					const parts = (partial + data.toString("utf8")).split(/(\r?\n|\r)/);
					partial = parts.pop() ?? "";
					// A carriage return that ends the chunk may be the first half of \r\n.
					if (partial === "" && parts.at(-1) === "\r") partial = `${parts.splice(-2)[0]}\r`;
					for (let i = 0; i + 1 < parts.length; i += 2) {
						emit(parts[i] ?? "");
						overwrite = parts[i + 1] === "\r";
					}
				},
			})
			.then(({ exitCode }) => {
				job.status = "exited";
				job.exitCode = exitCode;
			})
			.catch((error: Error) => {
				job.status = controller.signal.aborted ? "killed" : "failed";
				appendFileSync(log, `\n[shell] ${error.message}\n`);
			})
			.finally(() => {
				job.ended = Date.now();
				if (partial) emit(partial.replace(/\r$/, ""));
			});
		jobs.set(id, job);
		return job;
	};

	/** Resolves when a line matches `pattern`, after `seconds`, when the job ends, or when the user interrupts, whichever is first. */
	const waitFor = (job: Job, pattern: RegExp | undefined, seconds: number | undefined, signal: AbortSignal | undefined) => {
		type Why = "match" | "time" | "exit" | "abort" | "interrupt";
		const { promise, resolve } = Promise.withResolvers<Why>();
		let timer: NodeJS.Timeout | undefined;
		const onLine = (line: string) => {
			if (pattern?.test(line)) finish("match");
		};
		const onAbort = () => finish("abort");
		const finish = (why: Why) => {
			job.listeners.delete(onLine);
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			stopInterrupt();
			resolve(why);
		};
		if (pattern) job.listeners.add(onLine);
		if (seconds !== undefined) timer = setTimeout(() => finish("time"), seconds * 1000);
		signal?.addEventListener("abort", onAbort, { once: true });
		const stopInterrupt = onInterrupt(() => finish("interrupt"));
		void job.done.then(() => finish("exit"));
		return promise;
	};

	/** Streams the job's output to `onUpdate`; returns the function that stops. */
	const follow = (job: Job, onUpdate: AgentToolUpdateCallback<undefined> | undefined) => {
		const live: string[] = [];
		const stream = (line: string, replaces: boolean) => {
			if (replaces && live.length > 0) live[live.length - 1] = line;
			else if (live.push(line) > 200) live.shift();
			const bar = progressBar(line);
			onUpdate?.({ content: [{ type: "text", text: bar ? `${live.join("\n")}\n${bar}` : live.join("\n") }], details: undefined });
		};
		job.listeners.add(stream);
		return () => job.listeners.delete(stream);
	};

	const watchLater = (job: Job, pattern: RegExp) => {
		let wakes = 0;
		const onLine = (line: string) => {
			if (!pattern.test(line) || job.status !== "running") return;
			if (++wakes >= MAX_WAKES) job.listeners.delete(onLine);
			wake(`Job ${job.id} output matched /${pattern.source}/ (still running):\n${line}`);
		};
		job.listeners.add(onLine);
		void job.done.then(() => job.listeners.delete(onLine));
	};

	const reportExit = (job: Job) =>
		void job.done.then(() => {
			if (job.status === "killed") return;
			const failed = job.status !== "exited" || job.exitCode !== 0;
			wake(`Job finished: ${summary(job)}\nLast lines:\n${tail(readLog(job))}`, failed);
		});

	const progress = (job: Job, why: string) => {
		const output = readLog(job, job.cursor);
		job.cursor += Buffer.byteLength(output);
		const truncated = truncateTail(output);
		const note = truncated.truncated ? `[output truncated, full log: ${job.log}]\n` : "";
		return text(`${why}\n${summary(job)}\n${note}${truncated.content}`);
	};

	const findJob = (id: string | undefined): Job => {
		const job = id ? jobs.get(id) : undefined;
		if (!job) throw new Error(`No job ${id ?? "(none given)"}; known: ${[...jobs.keys()].join(", ") || "none"}`);
		return job;
	};

	pi.on("session_shutdown", () => {
		for (const job of jobs.values()) if (job.status === "running") job.controller.abort();
	});

	/** The codemode `bash` tool: pi's result shape, run as a job so that an interrupt leaves the command running. */
	const bash = async (input: { command: string; timeout?: number; cwd?: string }, signal: AbortSignal | undefined, onUpdate: AgentToolUpdateCallback<undefined> | undefined) => {
		const job = await start(input.command, dirOf(input.cwd));
		const unfollow = follow(job, onUpdate);
		const why = await waitFor(job, undefined, input.timeout, signal);
		unfollow();
		if (why === "interrupt") {
			reportExit(job);
			// Throwing ends the calling script, so its later steps cannot run while this command still does.
			const moved = progress(job, "The user interrupted; moved to the background. The shell tool can read, wait on, or kill this job.");
			throw new Error(moved.content.map((part) => (part.type === "text" ? part.text : "")).join(""));
		}
		if (why !== "exit") {
			job.controller.abort();
			await job.done;
			jobs.delete(job.id);
			const status = why === "abort" ? "Command aborted" : `Command timed out after ${input.timeout} seconds`;
			throw new Error(`${truncateTail(readLog(job)).content}\n\n${status}`);
		}
		const result = finished(job);
		if (job.status !== "exited" || job.exitCode == null) throw new Error(result.content[0]?.text);
		const full = truncateTail(readLog(job), { maxBytes: STRUCTURED_MAX_BYTES, maxLines: Number.MAX_SAFE_INTEGER });
		const structuredContent = {
			output: full.content,
			truncated: full.truncated,
			...(full.truncated ? { full_output_path: job.log } : {}),
			exit_code: job.exitCode,
			wall_time_seconds: Math.round(((job.ended ?? Date.now()) - job.started) / 100) / 10,
		};
		return { ...result, structuredContent };
	};

	pi.registerTool({
		name: "shell",
		label: "Shell",
		description:
			"Run processes: builds, tests, git, gh, nix, ssh, servers. Commands run in bash inside the repository's devshell. A foreground command still running after `timeout`, or when the user interrupts, moves to the background and wakes you when it exits. Background jobs return early on `wait_on` or `wait_seconds`. Read and search files with read/grep, not shell.",
		promptSnippet: "Run processes (builds, tests, git, nix, ssh); background jobs with early return",
		parameters: params,
		exposure: "model-only",
		async execute(_id, input: Params, signal, onUpdate, ctx: ExtensionToolContext) {
			if (input.action === "status") return text([...jobs.values()].map(summary).join("\n") || "No jobs.");
			if (input.action === "kill") {
				const job = findJob(input.job);
				job.controller.abort();
				await job.done;
				return text(summary(job));
			}
			const pattern = input.wait_on ? new RegExp(input.wait_on.replace(/^\(\?i\)/, ""), input.wait_on.startsWith("(?i)") ? "i" : "") : undefined;
			if (input.action === "read") return progress(findJob(input.job), "New output:");
			if (input.action === "wait") {
				const job = findJob(input.job);
				const why = await waitFor(job, pattern, input.wait_seconds, signal);
				return progress(job, `Wait ended: ${why}.`);
			}
			if (!input.command) throw new Error("command is required");
			const cwd = dirOf(input.cwd);
			const route = grepRoute(input.command);
			if (route && !input.background) {
				const outcome = await ctx.executeTool("grep", { ...route, path: route.path ?? cwd }, { signal });
				if (!outcome.isError) return { content: outcome.result.content, details: undefined };
			}
			const job = await start(input.command, cwd);
			if (input.background && !pattern && input.wait_seconds === undefined) {
				reportExit(job);
				return text(`Started ${job.id}; you are woken when it exits.\nlog: ${job.log}`);
			}
			const unfollow = follow(job, onUpdate);
			const seconds = input.background ? input.wait_seconds : (input.wait_seconds ?? input.timeout ?? DEFAULT_TIMEOUT_S);
			const why = await waitFor(job, pattern, seconds, signal);
			unfollow();
			if (why === "abort") {
				job.controller.abort();
				await job.done;
				return progress(job, "Cancelled.");
			}
			if (why === "exit") return finished(job);
			if (pattern) watchLater(job, pattern);
			reportExit(job);
			const moved = why === "match" ? "Matched; still running." : why === "interrupt" ? "The user interrupted; moved to the background." : "Still running; moved to the background.";
			return progress(job, moved);
		},
	});

	return { bash };
}
