import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Env = Record<string, string | undefined>;

export interface Devshell {
	root: string;
	kind: "direnv" | "devenv" | "flake" | "shell.nix";
	/** Variables to set; `undefined` unsets. */
	env: Env;
}

// Variables `nix develop` does not take from the shell derivation.
const IGNORED = new Set([
	"BASHOPTS",
	"HOME",
	"NIX_BUILD_TOP",
	"NIX_ENFORCE_PURITY",
	"NIX_LOG_FD",
	"NIX_REMOTE",
	"PPID",
	"SHELL",
	"SHELLOPTS",
	"SSL_CERT_FILE",
	"TEMP",
	"TEMPDIR",
	"TERM",
	"TMP",
	"TMPDIR",
	"TZ",
	"UID",
]);

const MARKERS = [".envrc", "devenv.nix", "flake.nix", "shell.nix"];

export function findRoot(cwd: string): string | undefined {
	const home = homedir();
	for (let dir = cwd; ; dir = dirname(dir)) {
		if (MARKERS.some((marker) => existsSync(join(dir, marker)))) return dir;
		if (dir === home || dir === dirname(dir)) return undefined;
	}
}

const cacheDir = () => join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pi-devshell");

function fingerprint(root: string, files: string[]): string {
	const hash = createHash("sha256").update(root);
	for (const file of files) {
		const path = join(root, file);
		if (!existsSync(path)) continue;
		hash.update(file).update(String(statSync(path).mtimeMs)).update(readFileSync(path));
	}
	return hash.digest("hex").slice(0, 32);
}

async function cached(key: string, load: () => Promise<Env>): Promise<Env> {
	const file = join(cacheDir(), `${key}.json`);
	try {
		return JSON.parse(readFileSync(file, "utf8")) as Env;
	} catch {
		const env = await load();
		mkdirSync(cacheDir(), { recursive: true });
		writeFileSync(file, JSON.stringify(env));
		return env;
	}
}

interface DevEnvJson {
	variables: Record<string, { type: string; value: unknown }>;
}

function fromDevEnv(json: string): Env {
	const parsed = JSON.parse(json) as DevEnvJson;
	const env: Env = {};
	for (const [name, variable] of Object.entries(parsed.variables)) {
		if (variable.type === "exported" && typeof variable.value === "string" && !IGNORED.has(name)) env[name] = variable.value;
	}
	return env;
}

async function direnv(root: string, cwd: string): Promise<Env | undefined> {
	try {
		const { stdout } = await run("direnv", ["export", "json"], { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, DIRENV_LOG_FORMAT: "" } });
		if (!stdout.trim()) return existsSync(join(root, ".envrc")) ? undefined : {};
		return JSON.parse(stdout) as Env;
	} catch {
		return undefined;
	}
}

interface DirenvStatus {
	state?: { foundRC?: { allowed?: unknown } | null };
}

/** Whether direnv allows the `.envrc` that governs `dir` (`direnv status --json`, allowed 0). */
export async function direnvAllowed(dir: string): Promise<boolean> {
	try {
		const { stdout } = await run("direnv", ["status", "--json"], { cwd: dir });
		// direnv's own JSON output; a missing field just means "not allowed".
		const status: DirenvStatus = JSON.parse(stdout);
		return status.state?.foundRC?.allowed === 0;
	} catch {
		return false;
	}
}

export async function resolveDevshell(cwd: string): Promise<Devshell | undefined> {
	const root = findRoot(cwd);
	if (!root) return undefined;
	const has = (file: string) => existsSync(join(root, file));
	if (has(".envrc") && (await direnvAllowed(root))) {
		const env = await direnv(root, cwd);
		if (env) return { root, kind: "direnv", env };
	}
	if (has("devenv.nix")) {
		const key = fingerprint(root, ["devenv.nix", "devenv.yaml", "devenv.lock"]);
		const env = await cached(`devenv-${key}`, async () => {
			const { stdout } = await run("devenv", ["print-dev-env", "--json"], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
			return fromDevEnv(stdout);
		});
		return { root, kind: "devenv", env };
	}
	if (has("flake.nix")) {
		const key = fingerprint(root, ["flake.nix", "flake.lock"]);
		const env = await cached(`flake-${key}`, async () => {
			const { stdout } = await run("nix", ["print-dev-env", "--json", root], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
			return fromDevEnv(stdout);
		});
		return { root, kind: "flake", env };
	}
	if (has("shell.nix")) {
		const key = fingerprint(root, ["shell.nix"]);
		const env = await cached(`shellnix-${key}`, async () => {
			const { stdout } = await run("nix", ["print-dev-env", "--json", "-f", join(root, "shell.nix")], {
				cwd: root,
				maxBuffer: 64 * 1024 * 1024,
			});
			return fromDevEnv(stdout);
		});
		return { root, kind: "shell.nix", env };
	}
	return undefined;
}

/** Applies a devshell to a process environment; the devshell's PATH goes in front of the inherited one. */
export function applyEnv(base: NodeJS.ProcessEnv, devshell: Devshell | undefined): NodeJS.ProcessEnv {
	if (!devshell) return base;
	const env: NodeJS.ProcessEnv = { ...base };
	for (const [name, value] of Object.entries(devshell.env)) {
		if (value === undefined || value === null) delete env[name];
		else env[name] = value;
	}
	if (devshell.kind !== "direnv" && devshell.env.PATH && base.PATH) env.PATH = `${devshell.env.PATH}:${base.PATH}`;
	return env;
}
