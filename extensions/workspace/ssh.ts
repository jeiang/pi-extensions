import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import type { registerShell } from "./shell.ts";

const exec = promisify(execFile);
const DEFAULT_OPTIONS: Record<string, string> = { BatchMode: "yes", ConnectTimeout: "10" };
/** The tool owns connection sharing; a caller's value would break it. */
const OWNED = new Set(["controlmaster", "controlpath", "controlpersist"]);
/** They run local programs or load local code, out of the guards' sight, or replace the command. */
const REFUSED = new Set(["proxycommand", "localcommand", "permitlocalcommand", "knownhostscommand", "remotecommand", "pkcs11provider", "securitykeyprovider"]);
const HOST = /^[A-Za-z0-9_.@:[\]-]+$/;
const OPTION = /^[A-Za-z][A-Za-z0-9]*$/;

const params = Type.Object({
	host: Type.String({ description: "Host, user@host, or a Host alias from ~/.ssh/config." }),
	command: Type.String({ description: "Command for the remote bash, whatever the remote login shell is; one program per call, as with run()." }),
	cwd: Type.Optional(Type.String({ description: "Remote directory to run in." })),
	options: Type.Optional(
		Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]), {
			description: "ssh -o options, e.g. { User: \"deploy\", ProxyJump: \"edge\", ConnectTimeout: 5 }. Defaults: BatchMode yes, ConnectTimeout 10.",
		}),
	),
	timeout: Type.Optional(Type.Number({ description: "Seconds before the command is killed (no default)." })),
	tail: Type.Optional(Type.Number({ description: "Return only the last N lines; the full output stays in the log file named in `log`." })),
	background: Type.Optional(Type.Boolean({ description: "Start as a background shell job; tools.shell reads, waits on, or kills it." })),
});
type Params = Static<typeof params>;

const outputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr, up to 1 MiB." }),
	truncated: Type.Optional(Type.Boolean()),
	log: Type.Optional(Type.String()),
	exit_code: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	job: Type.Optional(Type.String({ description: "The background job's id." })),
});

/** Single-quotes `value` for the local bash. */
export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** `-o` arguments: the defaults, then the caller's options, validated. */
export function sshOptions(options: Params["options"] = {}): string[] {
	const merged: Record<string, string> = { ...DEFAULT_OPTIONS };
	for (const [key, value] of Object.entries(options)) {
		if (!OPTION.test(key)) throw new Error(`Not an ssh option name: ${key}`);
		if (OWNED.has(key.toLowerCase())) throw new Error(`${key} is managed by the ssh tool.`);
		if (REFUSED.has(key.toLowerCase())) throw new Error(`${key} runs local programs or replaces the command; use ProxyJump, or run() for local work.`);
		merged[key] = typeof value === "boolean" ? (value ? "yes" : "no") : String(value);
	}
	return Object.entries(merged).flatMap(([key, value]) => ["-o", `${key}=${value}`]);
}

/**
 * The remote command line: the script travels base64-encoded and runs under bash, so the remote
 * login shell (fish on these hosts) parses nothing but `echo`, `base64`, and `bash`.
 */
export function remoteCommand(command: string, cwd?: string): string {
	const script = cwd ? `cd -- ${quote(cwd)} || exit\n${command}` : command;
	return `echo ${Buffer.from(script).toString("base64")} | base64 -d | bash`;
}

type Shell = ReturnType<typeof registerShell>;

/** The `ssh` tool: one shared connection per host and option set for the session, commands run as shell jobs. */
export function registerSsh(pi: ExtensionAPI, shell: Shell) {
	// Unix socket paths are capped near 104 bytes, so the sockets live in a short directory.
	const socketDir = `/tmp/pi-ssh-${userInfo().uid}`;
	const masters = new Map<string, { path: string; host: string; ready: Promise<void> }>();

	const control = (host: string, opts: string[]) => {
		const key = createHash("sha256").update(JSON.stringify([host, opts])).digest("hex").slice(0, 16);
		return { key, path: `${socketDir}/${process.pid}-${key}` };
	};

	/** Opens the master once; parallel calls wait for it, and a dead one is reopened. */
	const ensureMaster = (host: string, opts: string[]) => {
		const { key, path } = control(host, opts);
		const ssh = async (args: string[]) => exec("ssh", ["-o", `ControlPath=${path}`, ...args], { env: await shell.env(shell.dirOf()) });
		const previous = masters.get(key)?.ready ?? Promise.resolve();
		const ready = previous
			.catch(() => undefined)
			.then(async () => {
				const alive = await ssh(["-O", "check", host]).then(
					() => true,
					() => false,
				);
				if (alive) return;
				mkdirSync(socketDir, { recursive: true, mode: 0o700 });
				await ssh([...opts, "-o", "ControlMaster=yes", "-o", "ControlPersist=30m", "-fN", host]).catch((error: Error & { stderr?: string }) => {
					throw new Error(`ssh to ${host} failed: ${(error.stderr ?? error.message).trim()}`);
				});
			});
		masters.set(key, { path, host, ready });
		return ready.then(() => path);
	};

	// Synchronous, so the masters close before the process exits; ControlPersist bounds any that do not.
	pi.on("session_shutdown", () => {
		for (const { path, host } of masters.values()) {
			try {
				execFileSync("ssh", ["-o", `ControlPath=${path}`, "-O", "exit", host], { stdio: "ignore", timeout: 2000 });
			} catch {}
		}
	});

	pi.registerTool({
		name: "ssh",
		label: "SSH",
		description:
			"Run a command on a remote host over one shared connection per host for the session, so parallel calls under settle() are cheap. The command runs under bash on the remote whatever its login shell, so it needs no extra quoting. Runs as a shell job: a log, tail, and background like run(). Scripts get { output, exit_code, log, truncated }.",
		promptSnippet: "Run remote commands over a shared ssh connection",
		parameters: params,
		outputSchema,
		exposure: "codemode",
		async execute(_id, input: Params, signal, onUpdate) {
			if (!HOST.test(input.host) || input.host.startsWith("-")) throw new Error(`Not a host: ${input.host}`);
			const opts = sshOptions(input.options);
			const path = await ensureMaster(input.host, opts);
			const command = ["ssh", ...opts, "-o", "ControlMaster=no", "-o", `ControlPath=${path}`, "--", input.host, remoteCommand(input.command, input.cwd)]
				.map(quote)
				.join(" ");
			const label = `ssh ${input.host}${input.cwd ? ` (in ${input.cwd})` : ""}: ${input.command}`;
			if (input.background) return shell.background(command, label);
			return shell.bash({ command, timeout: input.timeout, tail: input.tail, label }, signal, onUpdate);
		},
	});
}
