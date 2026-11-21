import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentToolResult, type ExtensionAPI, truncateTail } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const RUNNER = readFileSync(new URL("./runner.py", import.meta.url), "utf8");
const DONE = "\x00pi-python-done";
const DEFAULT_TIMEOUT_S = 120;
const INTERRUPT_GRACE_MS = 5_000;
const MAX_OUTPUT = 4 * 1024 * 1024;

export const PYTHON_REDIRECT =
	"Inline Python runs in the `python` tool: a persistent kernel in the repository's devshell that keeps imports and variables between calls (its stdin is closed, so read input from files, or run a command with subprocess). Running a script file (`python path/to/script.py`) or a module (`python -m pkg`) stays allowed in the shell.";

// A python interpreter at command position: line start, after a separator, or after a wrapper such as `uv run` or `nix develop -c`/`bash -c '`.
const PYTHON_CALL =
	/(?:^|[;&|(`\n]|\b(?:then|do|else|exec|time|run|env)|\s-c\s+['"]?)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\S*\/)?python(?:3(?:\.\d+)?)?(?=[\s;&|)'"]|$)([^\n;&|)]*)/g;
const VALUE_FLAGS = new Set(["-W", "-X", "--check-hash-based-pycs"]);

/** Why `command` should use the python tool: it runs inline code (`-c`, stdin, a heredoc) or an interactive interpreter. */
export function inlinePython(command: string): boolean {
	for (const match of command.matchAll(PYTHON_CALL)) {
		const tokens = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
		let i = 0;
		while (tokens[i]?.startsWith("-") && !["-c", "-m", "-"].includes(tokens[i] ?? "")) i += VALUE_FLAGS.has(tokens[i] ?? "") ? 2 : 1;
		const first = tokens[i];
		if (first === "-m") continue;
		// A bare interpreter reads stdin; one with only flags (`--version`) does not.
		if ((first === undefined && tokens.length === 0) || first === "-c" || first === "-" || first?.startsWith("<")) return true;
	}
	return false;
}

export interface PythonOptions {
	cwd: () => string;
	env: (cwd: string) => Promise<NodeJS.ProcessEnv>;
	devshellError: (cwd: string) => string | undefined;
}

interface Kernel {
	cwd: string;
	child: ChildProcessWithoutNullStreams;
	exited: Promise<void>;
}

const params = Type.Object({
	code: Type.Optional(Type.String({ description: "Python source. The value of a final expression is printed, like a REPL. Top-level await works." })),
	timeout: Type.Optional(Type.Number({ description: `Seconds before the cell is interrupted with KeyboardInterrupt (default ${DEFAULT_TIMEOUT_S}).` })),
	reset: Type.Optional(Type.Boolean({ description: "Restart the kernel, dropping all state, before running code." })),
});

const text = (value: string, isError = false): AgentToolResult<undefined> & { isError: boolean } => ({
	content: [{ type: "text", text: value }],
	details: undefined,
	isError,
});

export function registerPython(pi: ExtensionAPI, options: PythonOptions) {
	let kernel: Kernel | undefined;
	let queue: Promise<unknown> = Promise.resolve();

	const signalGroup = (child: ChildProcessWithoutNullStreams, sig: NodeJS.Signals) => {
		// The kernel leads its own process group, so subprocesses a cell started get the signal too.
		try {
			if (child.pid) process.kill(-child.pid, sig);
		} catch {
			child.kill(sig);
		}
	};

	const stop = async () => {
		const current = kernel;
		kernel = undefined;
		if (!current) return;
		signalGroup(current.child, "SIGKILL");
		await current.exited;
	};

	const start = async (cwd: string): Promise<Kernel> => {
		const env = await options.env(cwd);
		const venv = join(cwd, ".venv", "bin", "python");
		const python = existsSync(venv) ? venv : "python3";
		const child = spawn(python, ["-u", "-c", RUNNER], { cwd, env: { ...env, PYTHONUNBUFFERED: "1" }, stdio: "pipe", detached: true });
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		// `exit`, not `close`: a subprocess the cell left running can hold the pipes open.
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
			child.once("error", () => resolve());
		});
		const started: Kernel = { cwd, child, exited };
		void exited.then(() => {
			if (kernel === started) kernel = undefined;
		});
		return started;
	};

	let cells = 0;
	const execute = async (kernelNow: Kernel, code: string, timeoutS: number, signal: AbortSignal | undefined) => {
		const { child } = kernelNow;
		const id = String(++cells);
		const marker = `\n${DONE} ${id}`;
		let output = "";
		const done = { stdout: false, stderr: false };
		let ok = false;
		const { promise, resolve } = Promise.withResolvers<"done" | "exit">();
		const pending = { stdout: "", stderr: "" };
		const append = (value: string) => {
			output = (output + value).slice(-MAX_OUTPUT);
		};
		const onData = (stream: "stdout" | "stderr") => (chunk: string) => {
			if (done[stream]) return;
			pending[stream] += chunk;
			const at = pending[stream].indexOf(marker);
			const end = at === -1 ? -1 : pending[stream].indexOf("\n", at + 1);
			if (end === -1) {
				// Keep a tail that may hold the start of a split marker.
				const keep = at === -1 ? marker.length : pending[stream].length - at;
				append(pending[stream].slice(0, -keep || undefined));
				pending[stream] = pending[stream].slice(-keep);
				return;
			}
			append(pending[stream].slice(0, at));
			if (stream === "stdout") ok = (JSON.parse(pending[stream].slice(at + marker.length, end).trim() || "{}") as { ok?: boolean }).ok === true;
			pending[stream] = "";
			done[stream] = true;
			if (done.stdout && done.stderr) resolve("done");
		};
		const onStdout = onData("stdout");
		const onStderr = onData("stderr");
		child.stdout.on("data", onStdout);
		child.stderr.on("data", onStderr);
		void kernelNow.exited.then(() => resolve("exit"));

		let interrupted = "";
		let escalation: NodeJS.Timeout | undefined;
		const interrupt = (why: string) => {
			if (interrupted) return;
			interrupted = why;
			signalGroup(child, "SIGINT");
			escalation = setTimeout(() => signalGroup(child, "SIGKILL"), INTERRUPT_GRACE_MS);
		};
		const timer = setTimeout(() => interrupt(`Interrupted after ${timeoutS}s.`), timeoutS * 1000);
		const onAbort = () => interrupt("Cancelled.");
		signal?.addEventListener("abort", onAbort, { once: true });

		child.stdin.write(`${JSON.stringify({ id, code })}\n`);
		const why = await promise;
		clearTimeout(timer);
		clearTimeout(escalation);
		signal?.removeEventListener("abort", onAbort);
		child.stdout.off("data", onStdout);
		child.stderr.off("data", onStderr);
		append(pending.stdout + pending.stderr);
		const notes = [interrupted, why === "exit" ? `The kernel exited (code ${child.exitCode ?? child.signalCode}); its state is gone and the next call starts a fresh one.` : ""];
		return { output, ok: ok && why === "done" && !interrupted, notes: notes.filter(Boolean) };
	};

	pi.on("session_shutdown", () => void stop());

	pi.registerTool({
		name: "python",
		label: "Python",
		description:
			"Run Python in a persistent kernel: imports, variables, and loaded data stay between calls until reset. It runs in the repository's devshell (or its .venv) with the session's working directory, stdin closed, and stdout and stderr returned. Use it for data inspection, calculations, and one-off scripts instead of `python -c` or heredocs in the shell. Run reusable script files that live in the repository with the shell.",
		promptSnippet: "Persistent Python kernel in the devshell; use instead of `python -c` or heredocs",
		promptGuidelines: [
			"Default to the python tool for inline Python; the shell blocks `python -c`, heredocs, and piped stdin, but runs script files and `python -m`.",
		],
		parameters: params,
		exposure: "model-only",
		async execute(_id, input: Static<typeof params>, signal) {
			const run = async () => {
				const cwd = options.cwd();
				const notes: string[] = [];
				if (input.reset) await stop();
				if (kernel && kernel.cwd !== cwd) {
					await stop();
					notes.push(`The working directory changed to ${cwd}; the kernel restarted there and earlier state is gone.`);
				}
				if (!input.code) return text([...notes, input.reset ? "Kernel reset." : "Nothing to run."].join("\n"));
				kernel ??= await start(cwd);
				const devshellError = options.devshellError(cwd);
				if (devshellError) notes.unshift(`devshell failed, running without it:\n${devshellError}`);
				const result = await execute(kernel, input.code, input.timeout ?? DEFAULT_TIMEOUT_S, signal);
				const truncated = truncateTail(result.output);
				const body = [...notes, truncated.truncated ? "[output truncated to its tail]" : "", truncated.content.trim(), ...result.notes]
					.filter(Boolean)
					.join("\n");
				return text(body || "(no output)", !result.ok);
			};
			const next = queue.then(run, run);
			queue = next.catch(() => undefined);
			return next;
		},
	});
}
