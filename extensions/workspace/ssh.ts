import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { userInfo } from "node:os";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const exec = promisify(execFile);
const DEFAULT_OPTIONS: Record<string, string> = { BatchMode: "yes", ConnectTimeout: "10" };
/** The tool owns connection sharing; a caller's value would break it. */
const OWNED = new Set(["controlmaster", "controlpath", "controlpersist"]);
/** They run local programs or load local code, out of the guards' sight, or replace the command. */
const REFUSED = new Set(["proxycommand", "localcommand", "permitlocalcommand", "knownhostscommand", "remotecommand", "pkcs11provider", "securitykeyprovider"]);
const HOST = /^[A-Za-z0-9_.@:[\]-]+$/;
const OPTION = /^[A-Za-z][A-Za-z0-9]*$/;

type SshParams = { options?: Record<string, string | number | boolean>; identity?: string; port?: number; agent_forward?: boolean };

const transferParams = Type.Object({
	host: Type.String({ description: "Host, user@host, or a Host alias from ~/.ssh/config." }),
	direction: Type.Union([Type.Literal("upload"), Type.Literal("download")]),
	local: Type.String({ description: "Local file or directory, relative to the session directory or absolute." }),
	remote: Type.String({ description: "Remote path; relative paths start in the remote home." }),
	recursive: Type.Optional(Type.Boolean({ description: "Copy a directory (-r)." })),
	ssh: Type.Optional(
		Type.Object({
			options: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
			identity: Type.Optional(Type.String()),
			port: Type.Optional(Type.Number()),
			agent_forward: Type.Optional(Type.Boolean()),
		}),
	),
});
type TransferParams = Static<typeof transferParams>;

/** Single-quotes `value` for the local bash. */
export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** `-o` arguments: the defaults, then the caller's options, validated. */
export function sshOptions(options: SshParams["options"] = {}): string[] {
	const merged: Record<string, string> = { ...DEFAULT_OPTIONS };
	for (const [key, value] of Object.entries(options)) {
		if (!OPTION.test(key)) throw new Error(`Not an ssh option name: ${key}`);
		if (OWNED.has(key.toLowerCase())) throw new Error(`${key} is managed by the ssh tool.`);
		if (REFUSED.has(key.toLowerCase())) throw new Error(`${key} runs local programs or replaces the command; use ProxyJump, or run() for local work.`);
		merged[key] = typeof value === "boolean" ? (value ? "yes" : "no") : String(value);
	}
	return Object.entries(merged).flatMap(([key, value]) => ["-o", `${key}=${value}`]);
}

/** Options that belong to the shared connection, so two calls with different keys cannot share one. */
export function connectionFlags(input: { identity?: string; port?: number; agentForward?: boolean }): string[] {
	return [...(input.identity ? ["-i", input.identity] : []), ...(input.port ? ["-p", String(input.port)] : []), ...(input.agentForward ? ["-A"] : [])];
}

/**
 * Options for one session on the connection. A pty needs `-tt`: the local side has no terminal,
 * and a single `-t` then allocates none. Without stdin to pass, `-n` keeps ssh off it.
 */
export function sessionFlags(input: { tty?: boolean; stdin?: boolean }): string[] {
	return input.tty ? ["-tt"] : input.stdin ? [] : ["-n"];
}

/**
 * The remote command line: the script travels base64-encoded and runs under bash, so the remote
 * login shell (fish on these hosts) parses nothing but `echo`, `base64`, and `bash`. With
 * `stdin`, the script arrives as an argument so bash's stdin stays the caller's.
 */
export function remoteCommand(command: string, cwd?: string, stdin = false): string {
	const script = cwd ? `cd -- ${quote(cwd)} || exit\n${command}` : command;
	const encoded = Buffer.from(script).toString("base64");
	return stdin ? `bash -c "$(echo ${encoded} | base64 -d)"` : `echo ${encoded} | base64 -d | bash`;
}

/**
 * One shared ssh connection per host and option set for the session: `command` gives the local
 * command line that runs a command over it, and the `transfer` tool copies files over it.
 */
export function registerSsh(pi: ExtensionAPI, env: () => Promise<NodeJS.ProcessEnv>, dir: (path?: string) => string) {
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
		const ssh = async (args: string[]) => exec("ssh", ["-o", `ControlPath=${path}`, ...args], { env: await env() });
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
			} catch {
				// The master exited already; ControlPersist ends any that did not.
			}
		}
	});

	const connection = async (host: string, ssh: SshParams = {}) => {
		if (!HOST.test(host) || host.startsWith("-")) throw new Error(`Not a host: ${host}`);
		const opts = [...sshOptions(ssh.options), ...connectionFlags({ identity: ssh.identity, port: ssh.port, agentForward: ssh.agent_forward })];
		return { opts, path: await ensureMaster(host, opts) };
	};

	const command = async (input: { host: string; command: string; cwd?: string; tty?: boolean; stdin?: boolean; ssh?: SshParams }) => {
		const { opts, path } = await connection(input.host, input.ssh);
		return ["ssh", ...opts, ...sessionFlags(input), "-o", "ControlMaster=no", "-o", `ControlPath=${path}`, "--", input.host, remoteCommand(input.command, input.cwd, input.stdin)]
			.map(quote)
			.join(" ");
	};

	pi.registerTool({
		name: "transfer",
		label: "Transfer",
		description: "Copy a file or directory to (upload) or from (download) a host over the session's shared ssh connection, with scp. Scripts get { output }.",
		promptSnippet: "Copy files to or from a host over the shared ssh connection",
		parameters: transferParams,
		exposure: "codemode",
		async execute(_id, input: TransferParams, signal) {
			// The port goes as scp's -P, so only the connection's -o options and key pass through here.
			const { opts, path } = await connection(input.host, input.ssh);
			const scpOpts = opts.flatMap((arg, i, all) => (arg === "-p" ? ["-P", all[i + 1] ?? ""] : all[i - 1] === "-p" ? [] : arg === "-A" ? [] : [arg]));
			const local = dir(input.local.replace(/^@/, ""));
			const remote = `${input.host}:${input.remote}`;
			const [from, to] = input.direction === "upload" ? [local, remote] : [remote, local];
			const { stdout, stderr } = await exec("scp", [...scpOpts, ...(input.recursive ? ["-r"] : []), "-o", "ControlMaster=no", "-o", `ControlPath=${path}`, "--", from, to], {
				env: await env(),
				signal,
			});
			const output = `${input.direction === "upload" ? "Uploaded" : "Downloaded"} ${from} -> ${to}${(stdout + stderr).trim() ? `\n${(stdout + stderr).trim()}` : ""}`;
			return { content: [{ type: "text", text: output }], details: undefined, structuredContent: { output } };
		},
	});

	return { command };
}
