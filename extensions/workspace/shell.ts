import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionToolContext,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const DEFAULT_TIMEOUT_S = 120;
/** A wait with no bound of its own returns after this many seconds; the job keeps running. */
const DEFAULT_WAIT_S = 120;

/** Seconds to wait for a job: the caller's bound, else the fallback when no pattern can end the wait. */
export function waitBound(input: { wait_on?: string; wait_seconds?: number }, fallback = DEFAULT_WAIT_S): number | undefined {
	return input.wait_seconds ?? (input.wait_on ? undefined : fallback);
}
const TAIL_LINES = 30;
/** A shell command's stderr is captured separately, so a JSON payload on stdout stays parseable. */
const STDERR_MAX_BYTES = 256 * 1024;
const quotePath = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** The command under a pty, so a program that insists on a terminal (sudo) can prompt. */
export function ttyCommand(command: string, platform: NodeJS.Platform = process.platform): string {
	return platform === "darwin" ? `script -q /dev/null bash -c ${quotePath(command)}` : `script -qec ${quotePath(command)} /dev/null`;
}
/** A pty prints `^D` for the end of the caller's stdin and turns every newline into CRLF; neither belongs in the log. */
export function ttyOutput(text: string): string {
	return text.replace(/\^D\x08\x08/g, "").replace(/\r\n/g, "\n");
}
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
	/** Standard output alone, and standard error alone; the log holds both. */
	stdout?: string;
	stderr?: string;
	/** `overwrite`: the line replaces the one before it, as after a carriage return. */
	listeners: Set<(line: string, overwrite: boolean) => void>;
	done: Promise<void>;
}

export const cwdParam = Type.Optional(
	Type.String({
		description: "Directory to run in, such as a worktree of another repository; an absolute path, or relative to the session directory. Loads that directory's devshell.",
	}),
);

/** The pty flag, on the shell tool and the codemode `bash` tool its scripts call. */
export const ttyParam = Type.Optional(
	Type.Boolean({
		description:
			"Run under a pty, so a program that checks for a terminal works (`sudo` can prompt, progress output renders). stdout and stderr arrive merged, with line endings normalized; the log is still complete.",
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
	tail: Type.Optional(
		Type.Number({ description: "Return only the last N lines of output. The full output stays in the log file named in the result; read or grep it instead of piping into tail, head, or grep." }),
	),
	tty: ttyParam,
	action: Type.Optional(
		Type.Union([Type.Literal("status"), Type.Literal("read"), Type.Literal("wait"), Type.Literal("kill")], {
			description: "Act on jobs instead of running a command: status lists jobs; read returns new output; wait returns on wait_on, wait_seconds, or the job's exit, and otherwise after 120s with the job still running; kill stops it.",
		}),
	),
	job: Type.Optional(Type.String({ description: "Job id for read, wait, kill." })),
});

/** The last `lines` lines of `output`, and whether that left anything out. */
export function lastLines(output: string, lines: number) {
	const rows = output.replace(/\n$/, "").split("\n");
	const shown = rows.slice(-Math.max(1, Math.floor(lines)));
	return { content: shown.join("\n"), truncated: shown.length < rows.length };
}
type Params = Static<typeof params>;

export const shellOutputSchema = Type.Object({
	job: Type.Optional(Type.String()),
	status: Type.Optional(Type.String({ description: "running, exited, killed, or failed" })),
	exit_code: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	log: Type.Optional(Type.String({ description: "The full output; read or grep it." })),
	output: Type.String({ description: "stdout shown, or for action status the job summaries." }),
	stderr: Type.Optional(Type.String({ description: "stderr alone, which the log also holds after the stdout." })),
});
type ShellResult = Static<typeof shellOutputSchema>;

const text = (value: string): AgentToolResult<undefined> & { structuredContent: ShellResult } => ({
	content: [{ type: "text", text: value }],
	details: undefined,
	structuredContent: { output: value },
});

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
	let logDir = join(tmpdir(), "pi-shell");
	// Logs live beside the session file so their paths survive a restart or resume.
	pi.on("session_start", (_event, ctx) => {
		const file = ctx.sessionManager.getSessionFile();
		logDir = file ? join(dirname(file), basename(file, ".jsonl"), "logs") : join(tmpdir(), "pi-shell");
	});
	let next = 1;
	const dirOf = (input?: string) => {
		const dir = options.cwd(input);
		if (!existsSync(dir)) throw new Error(`No directory ${dir}`);
		return dir;
	};
	/** The last `lines` lines of `output`, or pi's default tail truncation. */
	const view = (output: string, lines?: number) => (lines === undefined ? truncateTail(output).content : lastLines(output, lines).content);
	const shape = (job: Job, output: string): ShellResult => ({
		job: job.id,
		status: job.status,
		...(job.exitCode !== undefined ? { exit_code: job.exitCode } : {}),
		log: job.log,
		output,
		...(job.stderr ? { stderr: job.stderr.slice(-STDERR_MAX_BYTES) } : {}),
	});
	/** The exit result of a foreground command; the job is done and forgotten. */
	const finished = (job: Job, lines?: number) => {
		jobs.delete(job.id);
		const output = view(readLog(job), lines);
		const status = job.status === "exited" ? (job.exitCode === 0 ? "" : `\nCommand exited with code ${job.exitCode}`) : `\n[${job.status}]`;
		const body = `${output}${status}`.trim() || "(no output)";
		return {
			content: [{ type: "text" as const, text: `${body}\nlog: ${job.log}` }],
			details: undefined,
			isError: job.status !== "exited" || job.exitCode !== 0,
			structuredContent: shape(job, output),
		};
	};

	const wake = (content: string, error = false) =>
		pi.sendMessage({ customType: "shell-job", content, display: true, details: { error } }, { triggerTurn: true, deliverAs: "steer" });

	const summary = (job: Job) => {
		const state = job.status === "exited" ? `exit ${job.exitCode}` : job.status;
		return `${job.id} [${state}, ${duration((job.ended ?? Date.now()) - job.started)}] ${job.command}\nlog: ${job.log}`;
	};

	/** `label` stands in for `command` in summaries, for a command that is not worth reading. */
	const start = async (command: string, cwd: string, label = command, tty = false): Promise<Job> => {
		mkdirSync(logDir, { recursive: true });
		const id = `job${next++}`;
		const log = join(logDir, `${process.pid}-${id}.log`);
		const env = await options.env(cwd);
		const devshellError = options.devshellError(cwd);
		writeFileSync(log, devshellError ? `[shell] devshell failed, ran without it:\n${devshellError}\n` : "");
		// stderr goes to its own file, so a command's JSON on stdout is not polluted by progress output.
		const errFile = join(logDir, `${process.pid}-${id}.err`);
		writeFileSync(errFile, "");
		const controller = new AbortController();
		const listeners: Job["listeners"] = new Set();
		let partial = "";
		let overwrite = false;
		const emit = (line: string) => {
			// A bare carriage return redraws nothing.
			if (overwrite && line === "") return;
			for (const listener of listeners) listener(line, overwrite);
		};
		const job: Job = { id, command: label, log, started: Date.now(), status: "running", controller, cursor: 0, listeners, done: Promise.resolve() };
		job.done = ops
			.exec(tty ? ttyCommand(command) : `{ ${command}\n} 2> ${quotePath(errFile)}`, cwd, {
				signal: controller.signal,
				env: { ...env, PYTHONUNBUFFERED: "1" },
				onData: (data) => {
					// The pty's own EOF marker and CRLF would otherwise reach the log and every parsed line.
					const text = tty ? ttyOutput(data.toString("utf8")) : data.toString("utf8");
					appendFileSync(log, tty ? text : data);
					const parts = (partial + text).split(/(\r?\n|\r)/);
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
				// The log holds both streams for reading later; the two fields keep them apart for parsing.
				job.stdout = existsSync(log) ? readFileSync(log, "utf8") : "";
				job.stderr = existsSync(errFile) ? readFileSync(errFile, "utf8") : "";
				if (job.stderr.trim()) appendFileSync(log, `\n[stderr]\n${job.stderr}`);
				if (partial) emit(partial.replace(/\r$/, ""));
			});
		jobs.set(id, job);
		return job;
	};

	/** Resolves when a line matches `pattern`, after `seconds`, or when the job ends, whichever is first. */
	const waitFor = (job: Job, pattern: RegExp | undefined, seconds: number | undefined, signal: AbortSignal | undefined) => {
		type Why = "match" | "time" | "exit" | "abort";
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
			resolve(why);
		};
		if (pattern) job.listeners.add(onLine);
		if (seconds !== undefined) timer = setTimeout(() => finish("time"), seconds * 1000);
		signal?.addEventListener("abort", onAbort, { once: true });
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

	const progress = (job: Job, why: string, lines?: number) => {
		const output = readLog(job, job.cursor);
		job.cursor += Buffer.byteLength(output);
		const shown = view(output, lines);
		return { ...text(`${why}\n${summary(job)}\n${shown}`), structuredContent: shape(job, shown) };
	};

	const findJob = (id: string | undefined): Job => {
		const job = id ? jobs.get(id) : undefined;
		if (!job) throw new Error(`No job ${id ?? "(none given)"}; known: ${[...jobs.keys()].join(", ") || "none"}`);
		return job;
	};

	pi.on("session_shutdown", () => {
		for (const job of jobs.values()) if (job.status === "running") job.controller.abort();
	});

	/** The codemode `bash` tool: pi's result shape, run as a job. */
	const bash = async (
		input: { command: string; timeout?: number; cwd?: string; tail?: number; label?: string; tty?: boolean },
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<undefined> | undefined,
	) => {
		const job = await start(input.command, dirOf(input.cwd), input.label, input.tty);
		const unfollow = follow(job, onUpdate);
		const why = await waitFor(job, undefined, input.timeout, signal);
		unfollow();
		if (why !== "exit") {
			job.controller.abort();
			await job.done;
			jobs.delete(job.id);
			const status = why === "abort" ? "Command aborted" : `Command timed out after ${input.timeout} seconds`;
			throw new Error(`${truncateTail(readLog(job)).content}\n\n${status}`);
		}
		const result = finished(job, input.tail);
		if (job.status !== "exited" || job.exitCode == null) throw new Error(result.content[0]?.text);
		const stdout = job.stdout ?? readLog(job);
		// `tail` is the agent's own cut; truncated says whether this output left out any of the log.
		const shown = input.tail === undefined ? truncateTail(stdout, { maxBytes: STRUCTURED_MAX_BYTES, maxLines: Number.MAX_SAFE_INTEGER }) : lastLines(stdout, input.tail);
		const structuredContent = {
			output: shown.content,
			stderr: (job.stderr ?? "").slice(-STDERR_MAX_BYTES),
			truncated: shown.truncated,
			...(shown.truncated ? { full_output_path: job.log } : {}),
			log: job.log,
			exit_code: job.exitCode,
			wall_time_seconds: Math.round(((job.ended ?? Date.now()) - job.started) / 100) / 10,
		};
		return { ...result, structuredContent };
	};

	/** Starts a job and returns within `seconds`: its result when it exits, otherwise a background job that wakes the session. */
	const waitStart = async (
		command: string,
		input: { seconds: number; label?: string; tail?: number; signal?: AbortSignal; onUpdate?: AgentToolUpdateCallback<undefined> },
	) => {
		const job = await start(command, dirOf(), input.label);
		const unfollow = follow(job, input.onUpdate);
		const why = await waitFor(job, undefined, input.seconds, input.signal);
		unfollow();
		if (why === "exit") return finished(job, input.tail);
		if (why === "abort") {
			job.controller.abort();
			await job.done;
			return progress(job, "Cancelled.", input.tail);
		}
		reportExit(job);
		return progress(job, `Still running after ${input.seconds}s; moved to the background.`, input.tail);
	};

	pi.registerTool({
		name: "shell",
		label: "Shell",
		description:
			"Run processes: builds, tests, git, gh, nix, ssh, servers. Commands run in bash inside the repository's devshell. stdout and stderr are captured separately, so a JSON payload on stdout stays parseable; progress output goes to stderr. A foreground command still running after `timeout` moves to the background and wakes you when it exits. Background jobs return early on `wait_on` or `wait_seconds`. Every result names the log file holding both streams; pass `tail` for the end, then read (offset/limit) the log. Scripts get { job, status, exit_code, log, output, stderr }; for one foreground command, run() is simpler.",
		promptSnippet: "Run processes (builds, tests, git, nix, ssh); background jobs with early return",
		exposure: "codemode",
		parameters: params,
		outputSchema: shellOutputSchema,
		async execute(_id, input: Params, signal, onUpdate, ctx: ExtensionToolContext) {
			if (input.action === "status") return text([...jobs.values()].map(summary).join("\n") || "No jobs.");
			if (input.action === "kill") {
				const job = findJob(input.job);
				job.controller.abort();
				await job.done;
				return { ...text(summary(job)), structuredContent: shape(job, "") };
			}
			const pattern = input.wait_on ? new RegExp(input.wait_on.replace(/^\(\?i\)/, ""), input.wait_on.startsWith("(?i)") ? "i" : "") : undefined;
			if (input.action === "read") return progress(findJob(input.job), "New output:", input.tail);
			if (input.action === "wait") {
				const job = findJob(input.job);
				// An unbounded wait is a turn that never returns; without a selector, bound it and let the job run on.
				const seconds = waitBound(input);
				const why = await waitFor(job, pattern, seconds, signal);
				const note = why === "time" ? `Still running after ${seconds}s; wait again or keep working.` : `Wait ended: ${why}.`;
				return progress(job, note, input.tail);
			}
			if (!input.command) throw new Error("command is required");
			const cwd = dirOf(input.cwd);
			const route = grepRoute(input.command);
			if (route && !input.background) {
				const outcome = await ctx.executeTool("grep", { ...route, path: route.path ?? cwd }, { signal });
				if (!outcome.isError) {
					const found = outcome.result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
					mkdirSync(logDir, { recursive: true });
					const log = join(logDir, `${process.pid}-grep${next++}.log`);
					writeFileSync(log, found);
					const shown = view(found, input.tail);
					return { ...text(`${shown}\nlog: ${log}`), structuredContent: { status: "exited", exit_code: 0, log, output: shown } };
				}
			}
			const job = await start(input.command, cwd, input.command, input.tty);
			if (input.background && !pattern && input.wait_seconds === undefined) {
				reportExit(job);
				return { ...text(`Started ${job.id}; you are woken when it exits.\nlog: ${job.log}`), structuredContent: shape(job, "") };
			}
			const unfollow = follow(job, onUpdate);
			const seconds = input.background ? input.wait_seconds : (input.wait_seconds ?? input.timeout ?? DEFAULT_TIMEOUT_S);
			const why = await waitFor(job, pattern, seconds, signal);
			unfollow();
			if (why === "abort") {
				job.controller.abort();
				await job.done;
				return progress(job, "Cancelled.", input.tail);
			}
			if (why === "exit") return finished(job, input.tail);
			if (pattern) watchLater(job, pattern);
			reportExit(job);
			const moved = why === "match" ? "Matched; still running." : "Still running; moved to the background.";
			return progress(job, moved, input.tail);
		},
	});

	/** Starts `command` as a background job that wakes the session when it exits. */
	const background = async (command: string, label: string) => {
		const job = await start(command, dirOf(), label);
		reportExit(job);
		return { ...text(`Started ${job.id}; you are woken when it exits.\nlog: ${job.log}`), structuredContent: shape(job, "") };
	};

	return { bash, background, waitStart, env: options.env, dirOf };
}
