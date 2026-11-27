import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, write, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	createLocalBashOperations,
	type ExtensionAPI,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import { promisify } from "node:util";
import { type Static, Type } from "typebox";
import { type TrackedJob, trackedJob, trackedJobs } from "./jobs.ts";

/** A wait with no bound of its own returns after this many seconds; the job keeps running. */
const DEFAULT_WAIT_S = 120;

/** Seconds to wait for a job: the caller's bound, else the fallback when no pattern can end the wait. */
export function waitBound(input: { wait_on?: string; wait_seconds?: number }, fallback = DEFAULT_WAIT_S): number | undefined {
	return input.wait_seconds ?? (input.wait_on ? undefined : fallback);
}
const TAIL_LINES = 30;
/** A shell command's stderr is captured separately, so a JSON payload on stdout stays parseable. */
const STDERR_MAX_BYTES = 256 * 1024;
/** A pipe write that waits off the event loop, so a full pipe never freezes the session. */
const writeFd = promisify(write);
const quotePath = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

/** The command under a pty, so a program that insists on a terminal (sudo) can prompt. The inner shell writes its pid, which is its session's id too. */
export function ttyCommand(command: string, platform: NodeJS.Platform = process.platform, pidFile?: string): string {
	const inner = pidFile ? `echo $$ > ${quotePath(pidFile)}; ${command}` : command;
	return platform === "darwin" ? `/usr/bin/script -q /dev/null bash -c ${quotePath(inner)}` : `script -qec ${quotePath(inner)} /dev/null`;
}
/** A pty prints `^D` for the end of the caller's stdin and turns every newline into CRLF; neither belongs in the log. */
export function ttyOutput(text: string): string {
	return text.replace(/\^D\x08\x08/g, "").replace(/\r\n/g, "\n");
}
/** Without a terminal sudo would wait for a password nobody can type, until the command's timeout. */
const SUDO_FAILS_FAST = 'sudo() { command sudo -n "$@"; }';

/**
 * The command as the shell runs it: stderr to its own file, so stdout alone stays parseable, under a pty when asked.
 * `stdinFile` feeds its standard input; without a pty, a bare `sudo` fails at once instead of waiting for a password.
 */
export function jobCommand(command: string, errFile: string, tty: boolean, pidFile?: string, stdinFile?: string): string {
	const body = tty ? command : `${SUDO_FAILS_FAST}\n${command}`;
	const wrapped = `{ ${body}\n} 2> ${quotePath(errFile)}${stdinFile ? ` < ${quotePath(stdinFile)}` : ""}`;
	return tty ? ttyCommand(wrapped, undefined, pidFile) : wrapped;
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
	/** A tty job's shell writes its pid here; it is the session `script`(1) made. */
	pidFile?: string;
	/** `overwrite`: the line replaces the one before it, as after a carriage return. */
	listeners: Set<(line: string, overwrite: boolean) => void>;
	done: Promise<void>;
	/** The write end of an interactive job's stdin pipe. */
	stdin?: number;
	/** The last pending write to it; each write waits for the one before, so input arrives in order. */
	written?: Promise<unknown>;
	/** Set once a result reached the agent, so the exit wake-up is not sent too. */
	claimed?: boolean;
}

const cwdParam = Type.Optional(
	Type.String({
		description: "Directory to run in, such as a worktree of another repository; an absolute path, or relative to the session directory. Loads that directory's devshell.",
	}),
);

/** The pty flag, on the shell tool and the codemode `bash` tool its scripts call. */
const ttyParam = Type.Optional(
	Type.Boolean({
		description:
			"Run under a pty, so a program that checks for a terminal works (`sudo` can prompt, progress output renders). stdout and stdin are the terminal, with line endings normalized; stderr stays apart, and the log holds both.",
	}),
);

const sshParams = Type.Object({
	options: Type.Optional(
		Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]), {
			description: 'ssh -o options, e.g. { User: "deploy", ProxyJump: "edge", ConnectTimeout: 5 }. Defaults: BatchMode yes, ConnectTimeout 10.',
		}),
	),
	identity: Type.Optional(Type.String({ description: "Private key file (-i), for a host that is not in ~/.ssh/config." })),
	port: Type.Optional(Type.Number({ description: "Remote port (-p)." })),
	agent_forward: Type.Optional(Type.Boolean({ description: "Forward the local ssh agent (-A)." })),
});

const runParams = Type.Object({
	command: Type.String({ description: "Shell command (bash). Runs inside the directory's devshell, or with host under the remote bash whatever its login shell." }),
	cwd: cwdParam,
	host: Type.Optional(
		Type.String({ description: "Run on this host (Host alias, user@host) over one shared ssh connection per host for the session; cwd is then the remote directory." }),
	),
	ssh: Type.Optional(sshParams),
	devshell: Type.Optional(Type.String({ description: "A named devshell of the directory's flake (nix develop .#<name>) instead of the default one." })),
	tty: ttyParam,
	stdin: Type.Optional(Type.String({ description: "Text for the command's standard input." })),
	interactive: Type.Optional(Type.Boolean({ description: "Keep standard input open, so job write can send input while the command runs." })),
	check: Type.Optional(Type.Boolean({ description: "Fail when the command exits non-zero (a script's call throws)." })),
	timeout: Type.Optional(Type.Number({ description: "Seconds before the command is killed (default: never)." })),
	wait_seconds: Type.Optional(
		Type.Number({ description: `Seconds to wait before returning a job handle while the command keeps running (default ${DEFAULT_WAIT_S}; with background, none).` }),
	),
	wait_on: Type.Optional(Type.String({ description: "Regex: return a job handle as soon as an output line matches; later matching lines wake you while it runs." })),
	background: Type.Optional(Type.Boolean({ description: "Return a job handle at once; you are woken when it exits." })),
	tail: Type.Optional(
		Type.Number({ description: "Return only the last N lines of output. The full output stays in the log file named in the result; read or grep it instead of piping into tail, head, or grep." }),
	),
});
type RunParams = Static<typeof runParams>;

const jobParams = Type.Object({
	action: Type.Union([Type.Literal("status"), Type.Literal("read"), Type.Literal("wait"), Type.Literal("kill"), Type.Literal("write")], {
		description:
			"status: list jobs (commands, background subagents, scripts, CI watches). read: new output since the last read. wait: until wait_on matches, wait_seconds pass, or the job ends, else 120s. kill: stop it. write: send input to an interactive command.",
	}),
	job: Type.Optional(Type.String({ description: "The job id a run handle, background subagent (its session), script, or watch named." })),
	wait_on: Type.Optional(Type.String({ description: "wait: regex to return on when an output line matches." })),
	wait_seconds: Type.Optional(Type.Number({ description: "wait: return after this many seconds even if the job still runs." })),
	input: Type.Optional(Type.String({ description: "write: text for the command's standard input; end it with a newline to send a line." })),
	tail: Type.Optional(Type.Number({ description: "Return only the last N lines of output." })),
});
type JobParams = Static<typeof jobParams>;

/** The last `lines` lines of `output`, and whether that left anything out. */
export function lastLines(output: string, lines: number) {
	const rows = output.replace(/\n$/, "").split("\n");
	const shown = rows.slice(-Math.max(1, Math.floor(lines)));
	return { content: shown.join("\n"), truncated: shown.length < rows.length };
}

const shellOutputSchema = Type.Object({
	job: Type.Optional(Type.String({ description: "The job id; job waits on, reads, writes to, or kills it." })),
	status: Type.Optional(Type.String({ description: "running, exited, killed, failed, or for other jobs done" })),
	exit_code: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	log: Type.Optional(Type.String({ description: "The full output; read or grep it." })),
	output: Type.String({ description: "stdout shown (up to 1 MiB), or for action status the job summaries." }),
	stderr: Type.Optional(Type.String({ description: "stderr alone, which the log also holds after the stdout." })),
	truncated: Type.Optional(Type.Boolean({ description: "Whether output leaves out part of stdout; the log holds all of it." })),
	wall_time_seconds: Type.Optional(Type.Number()),
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

export interface ShellOptions {
	/** The session directory, or `dir` resolved against it. */
	cwd: (dir?: string) => string;
	/** The environment for commands in `cwd`, with its devshell, or the named one of its flake. */
	env: (cwd: string, devshell?: string) => Promise<NodeJS.ProcessEnv>;
	/** Why the devshell for `cwd` failed to load, if it did. */
	devshellError: (cwd: string, devshell?: string) => string | undefined;
	/** The local command that runs `command` on a host over the shared connection. */
	sshCommand: (input: { host: string; command: string; cwd?: string; tty?: boolean; stdin?: boolean; ssh?: Static<typeof sshParams> }) => Promise<string>;
}

interface StartOptions {
	label?: string;
	tty?: boolean;
	stdin?: string;
	interactive?: boolean;
	devshell?: string;
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
	const start = async (command: string, cwd: string, start: StartOptions = {}): Promise<Job> => {
		const { label = command, tty = false } = start;
		mkdirSync(logDir, { recursive: true });
		const id = `job${next++}`;
		const log = join(logDir, `${process.pid}-${id}.log`);
		const env = await options.env(cwd, start.devshell);
		const devshellError = options.devshellError(cwd, start.devshell);
		// Text for stdin goes through a file; an interactive job reads a pipe that job write feeds.
		let stdinFile: string | undefined;
		let stdinFd: number | undefined;
		if (start.interactive) {
			stdinFile = join(logDir, `${process.pid}-${id}.in`);
			execFileSync("mkfifo", [stdinFile]);
			// Read-write, so opening the pipe does not wait for the reader.
			stdinFd = openSync(stdinFile, "r+");
		} else if (start.stdin !== undefined) {
			stdinFile = join(logDir, `${process.pid}-${id}.in`);
			writeFileSync(stdinFile, start.stdin);
		}
		writeFileSync(log, devshellError ? `[shell] devshell failed, ran without it:\n${devshellError}\n` : "");
		// stderr goes to its own file, inside the pty too, so a command's JSON on stdout stays parseable.
		const errFile = join(logDir, `${process.pid}-${id}.err`);
		writeFileSync(errFile, "");
		// A tty's shell is its own session, so its pid is the only handle on the group that holds the command.
		const pidFile = tty ? join(logDir, `${process.pid}-${id}.pid`) : undefined;
		if (pidFile) writeFileSync(pidFile, "");
		const controller = new AbortController();
		const listeners: Job["listeners"] = new Set();
		let partial = "";
		let overwrite = false;
		const emit = (line: string) => {
			// A bare carriage return redraws nothing.
			if (overwrite && line === "") return;
			for (const listener of listeners) listener(line, overwrite);
		};
		const job: Job = { id, command: label, log, started: Date.now(), status: "running", controller, cursor: 0, listeners, pidFile, done: Promise.resolve(), stdin: stdinFd };
		job.done = ops
			.exec(jobCommand(command, errFile, tty, pidFile, stdinFile), cwd, {
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
			if (job.stdin !== undefined) closeSync(job.stdin);
			job.stdin = undefined;
			for (const file of [pidFile, stdinFile])
				if (file)
					try {
						unlinkSync(file);
					} catch {
						// The file is gone already.
					}
		});
		// The reader runs now, so text more than a pipe holds drains instead of blocking.
		if (start.interactive && start.stdin && stdinFd !== undefined) job.written = writeFd(stdinFd, start.stdin).catch(() => undefined);
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

	// The wake waits a moment, so a job wait that returned this exit claims it first and no duplicate arrives.
	const reportExit = (job: Job) =>
		void job.done.then(() =>
			setTimeout(() => {
				if (job.status === "killed" || job.claimed) return;
				const failed = job.status !== "exited" || job.exitCode !== 0;
				wake(`Job finished: ${summary(job)}\nLast lines:\n${tail(readLog(job))}`, failed);
			}, 200),
		);

	const progress = (job: Job, why: string, lines?: number) => {
		const output = readLog(job, job.cursor);
		job.cursor += Buffer.byteLength(output);
		const shown = view(output, lines);
		return { ...text(`${why}\n${summary(job)}\n${shown}`), structuredContent: shape(job, shown) };
	};

	const regex = (source: string | undefined) => (source ? new RegExp(source.replace(/^\(\?i\)/, ""), source.startsWith("(?i)") ? "i" : "") : undefined);

	const findJob = (id: string | undefined): Job => {
		const job = id ? jobs.get(id) : undefined;
		if (!job) throw new Error(`No job ${id ?? "(none given)"}; known: ${[...jobs.keys()].join(", ") || "none"}`);
		return job;
	};

	/** The pid the pty's shell wrote before running its command, once it is there. */
	const ptyPid = (job: Job): number | undefined => {
		if (!job.pidFile) return undefined;
		try {
			const pid = Number(readFileSync(job.pidFile, "utf8").trim());
			return Number.isInteger(pid) && pid > 1 ? pid : undefined;
		} catch {
			return undefined;
		}
	};

	/** Ends a job and the group it runs in; a pty's shell is its own session, out of reach of the outer tree kill. */
	const stop = async (job: Job) => {
		if (job.status !== "running") return job.done;
		const pty = ptyPid(job);
		if (pty !== undefined) {
			try {
				process.kill(-pty, "SIGKILL");
			} catch {
				// It exited between the read and the signal.
			}
		}
		job.controller.abort();
		if (pty === undefined && job.pidFile) {
			// `script`(1) may still be starting the pty's shell; one that writes its pid after the abort is still ours.
			await new Promise((done) => setTimeout(done, 100));
			const late = ptyPid(job);
			if (late !== undefined)
				try {
					process.kill(-late, "SIGKILL");
				} catch {
					// It exited meanwhile.
				}
		}
		await job.done;
	};

	pi.on("session_shutdown", async () => {
		await Promise.all([...jobs.values()].filter((job) => job.status === "running").map(stop));
	});

	/** The exit result with stdout and stderr apart, for a script to parse. */
	const result = (job: Job, input: { command: string; tail?: number; check?: boolean; timeout?: number }) => {
		const base = finished(job, input.tail);
		const stdout = job.stdout ?? readLog(job);
		// `tail` is the agent's own cut; truncated says whether this output left out any of stdout.
		const shown = input.tail === undefined ? truncateTail(stdout, { maxBytes: STRUCTURED_MAX_BYTES, maxLines: Number.MAX_SAFE_INTEGER }) : lastLines(stdout, input.tail);
		const killed = job.status === "killed" && input.timeout !== undefined ? `Killed after the ${input.timeout}s timeout.` : "";
		const structuredContent: ShellResult = {
			...shape(job, shown.content),
			stderr: (job.stderr ?? "").slice(-STDERR_MAX_BYTES),
			truncated: shown.truncated,
			wall_time_seconds: Math.round(((job.ended ?? Date.now()) - job.started) / 100) / 10,
		};
		if (input.check && (job.status !== "exited" || job.exitCode !== 0)) {
			const why = job.status === "exited" ? `exit ${job.exitCode}` : killed || job.status;
			throw new Error(`${why}: ${input.command}\n${`${shown.content}\n${job.stderr ?? ""}`.trim().slice(-2000)}\nlog: ${job.log}`);
		}
		const content = killed ? [{ type: "text" as const, text: `${base.content[0]?.text}\n${killed}` }] : base.content;
		return { ...base, content, structuredContent };
	};

	/** A job still running: what it printed so far and how to reach it. */
	const handle = (job: Job, why: string, lines?: number) => {
		const shown = progress(job, `${why} job wait, read, write, or kill reach it as ${job.id}.`, lines);
		return shown;
	};

	pi.registerTool({
		name: "run",
		label: "Run",
		description:
			"Run a command: builds, tests, git, gh, nix, servers, or with host a command on another machine. Locally it runs in bash inside the directory's devshell. stdout and stderr are captured apart, so JSON on stdout stays parseable. timeout kills the command; a command still running after wait_seconds (default 120), a wait_on match, or at once with background returns a job handle and wakes you when it exits. check fails on a non-zero exit. Every result names the log holding both streams; pass tail for the end, then read the log. Scripts get { output, stderr, exit_code, status, log, truncated, wall_time_seconds, job }.",
		promptSnippet: "Run a command locally or on a host; background jobs with early return",
		exposure: "codemode",
		parameters: runParams,
		outputSchema: shellOutputSchema,
		async execute(_id, input: RunParams, signal, onUpdate) {
			if (input.host !== undefined && !input.host.trim()) throw new Error("host is empty; leave it out to run locally.");
			if (input.ssh && !input.host) throw new Error("ssh options need a host.");
			if (input.host && input.devshell) throw new Error("devshell applies to local commands; a host runs its own shell.");
			const command = input.host
				? await options.sshCommand({ host: input.host, command: input.command, cwd: input.cwd, tty: input.tty, stdin: input.stdin !== undefined || input.interactive, ssh: input.ssh })
				: input.command;
			const label = input.host ? `${input.host}${input.cwd ? ` (in ${input.cwd})` : ""}: ${input.command}` : input.command;
			const job = await start(command, input.host ? dirOf() : dirOf(input.cwd), {
				label,
				tty: input.tty,
				stdin: input.stdin,
				interactive: input.interactive,
				devshell: input.devshell,
			});
			if (input.timeout !== undefined) {
				const timer = setTimeout(() => void stop(job), input.timeout * 1000);
				void job.done.then(() => clearTimeout(timer));
			}
			const pattern = regex(input.wait_on);
			if (input.background && !pattern && input.wait_seconds === undefined) {
				reportExit(job);
				return handle(job, "Started in the background; you are woken when it exits.", input.tail);
			}
			const unfollow = follow(job, onUpdate);
			const seconds = input.wait_seconds ?? (input.background ? undefined : DEFAULT_WAIT_S);
			const why = await waitFor(job, pattern, seconds, signal);
			unfollow();
			if (why === "abort") {
				await stop(job);
				return progress(job, "Cancelled.", input.tail);
			}
			if (why === "exit") return result(job, input);
			if (pattern) watchLater(job, pattern);
			reportExit(job);
			return handle(job, why === "match" ? "Matched; still running." : `Still running after ${seconds}s; moved to the background, and you are woken when it exits.`, input.tail);
		},
	});

	const external = (id: string | undefined) => (id ? trackedJob(id) : undefined);
	const externalSummary = (job: TrackedJob) => `${job.id} [${job.kind} ${job.status}, ${duration((job.ended ?? Date.now()) - job.started)}] ${job.label}`;
	const externalResult = (job: TrackedJob, note: string) => {
		if (job.status !== "running") job.claimed = true;
		const body = job.status === "running" ? "" : `\n${job.result ?? ""}`;
		return { ...text(`${note}\n${externalSummary(job)}${body}`), structuredContent: { job: job.id, status: job.status, output: job.result ?? "" } };
	};

	pi.registerTool({
		name: "job",
		label: "Job",
		description:
			"Reach work that runs past its call: commands run returned as a handle, background subagents (by session), background scripts, and CI watches. status lists them; read returns new output; wait returns on wait_on, after wait_seconds, or at the end, else after 120s with the job still running; kill stops it; write sends input to an interactive command. A result returned here is not sent again as a wake-up.",
		promptSnippet: "Wait on, read, write to, or kill background jobs",
		parameters: jobParams,
		outputSchema: shellOutputSchema,
		async execute(_id, input: JobParams, signal) {
			if (input.action === "status") {
				const rows = [...[...jobs.values()].map(summary), ...trackedJobs().map(externalSummary)];
				return text(rows.join("\n") || "No jobs.");
			}
			const other = external(input.job);
			if (other) {
				if (input.action === "kill") {
					if (!other.kill) throw new Error(`${other.id} cannot be killed from here.`);
					other.kill();
					return externalResult(other, "Kill sent.");
				}
				if (input.action === "write") throw new Error(`${other.id} is a ${other.kind}, not an interactive command.`);
				if (input.action === "wait" && other.status === "running") {
					const seconds = waitBound(input) ?? DEFAULT_WAIT_S;
					const timer = Promise.withResolvers<void>();
					const handle = setTimeout(timer.resolve, seconds * 1000);
					const aborted = () => timer.resolve();
					signal?.addEventListener("abort", aborted, { once: true });
					await Promise.race([other.done, timer.promise]);
					clearTimeout(handle);
					signal?.removeEventListener("abort", aborted);
					return externalResult(other, other.status === "running" ? `Still running after ${seconds}s; wait again or keep working.` : "Finished.");
				}
				return externalResult(other, other.status === "running" ? "Still running." : "Finished.");
			}
			const job = findJob(input.job);
			if (input.action === "kill") {
				job.claimed = true;
				await stop(job);
				return { ...text(summary(job)), structuredContent: shape(job, "") };
			}
			if (input.action === "write") {
				if (job.stdin === undefined) throw new Error(`${job.id} has no open stdin; start it with run interactive: true.`);
				const fd = job.stdin;
				const text = input.input ?? "";
				const sent = (job.written ?? Promise.resolve()).then(() => writeFd(fd, text));
				job.written = sent.catch(() => undefined);
				await sent;
				return progress(job, "Sent.", input.tail);
			}
			if (input.action === "read") {
				if (job.status !== "running") job.claimed = true;
				return progress(job, "New output:", input.tail);
			}
			// An unbounded wait is a turn that never returns; without a selector, bound it and let the job run on.
			const seconds = waitBound(input);
			const why = await waitFor(job, regex(input.wait_on), seconds, signal);
			if (why === "exit") job.claimed = true;
			const note = why === "time" ? `Still running after ${seconds}s; wait again or keep working.` : `Wait ended: ${why}.`;
			return progress(job, note, input.tail);
		},
	});

	return { env: options.env, dirOf };
}
