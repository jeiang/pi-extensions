import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { previewPaths } from "../lsp/edits.ts";
import { sessionDir } from "../workspace/cwd.ts";

interface Rule {
	pattern: RegExp;
	reason: string;
}

const COMMAND_TOOLS: Record<string, true> = { run: true };
const PATH_TOOLS: Record<string, true> = { read: true, read_text: true, write: true, edit: true, replace: true, substitute: true, grep: true, find: true, ls: true };
const READ_TOOLS: Record<string, true> = { read: true, read_text: true, grep: true, find: true, ls: true };

const INSTALL = "Permanent installs are not allowed. Use `nix shell nixpkgs#<pkg> -c <cmd>` or `nix run`, or add the tool to the repository's devshell.";
const HISTORY = "Rewriting git history needs the user's explicit request.";

export const COMMAND_RULES: Rule[] = [
	{ pattern: /\b(brew|port)\s+install\b/, reason: INSTALL },
	{ pattern: /\b(npm|pnpm)\s+(i|install|add)\b[^|;&]*\s(-g|--global)\b/, reason: INSTALL },
	{ pattern: /\byarn\s+global\s+add\b/, reason: INSTALL },
	{ pattern: /\bcargo\s+install\b/, reason: INSTALL },
	{ pattern: /\bgo\s+install\b/, reason: INSTALL },
	{ pattern: /\bpip3?\s+install\b[^|;&]*\s--user\b/, reason: INSTALL },
	{ pattern: /\b(pipx|uv\s+tool)\s+install\b/, reason: INSTALL },
	{ pattern: /\bnix\s+profile\s+(install|add)\b/, reason: INSTALL },
	{ pattern: /\bnix-env\s+(-i|--install)/, reason: INSTALL },
	{ pattern: /\bgit\s+commit\b[^|;&]*\s--amend\b/, reason: HISTORY },
	{ pattern: /\bgit\s+rebase\b/, reason: HISTORY },
	{ pattern: /\bgit\s+reset\b[^|;&]*\s(--hard|--soft|--keep|--merge|HEAD[~^])/, reason: HISTORY },
	{ pattern: /\bgit\s+push\b[^|;&]*\s(-f\b|--force\b|--force-with-lease\b|\+\S)/, reason: HISTORY },
];

const SWITCH =
	"The main checkout stays on its branch, and the default branch stays in the main checkout. Switch branches inside a worktree, use the worktree tool (enter, create), or fast-forward the default branch with worktree ff_main.";

/** `command` without heredoc bodies and quoted strings, so text that only mentions a command does not count. */
export function unquoted(command: string): string {
	return command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, "").replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, "''");
}

/** `command` without heredoc bodies; quoted words keep their text so a quoted branch or path still counts. */
function unquotedWords(command: string): string {
	return command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, "").replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (_m, a, b) => (a ?? b).replace(/\s/g, "\u0000"));
}

/**
 * The branch switch `command` makes in the checkout it runs in: `git switch` or `git checkout` as a command,
 * not a `--` file restore. A `cd` or `git -C` points it at another repository, which is left alone.
 * `target` is the branch or revision named, `create` says it is a new branch.
 */
export function branchSwitch(command: string): { target?: string; create: boolean } | undefined {
	const plain = unquoted(command);
	if (/(^|[;&|(\n]\s*)cd\s/.test(plain) || !/(^|[;&|(\n]\s*)git\s+(switch\b|checkout\b(?![^|;&\n]*\s--(\s|$)))/.test(plain)) return undefined;
	const segment = unquotedWords(command)
		.split(/[;&|\n]/)
		.find((part) => /^\s*\(?\s*git\s+(switch|checkout)\b/.test(part));
	const words = (segment ?? "").trim().replace(/^\(\s*/, "").split(/\s+/).slice(2).map((word) => word.replace(/\u0000/g, " "));
	const create = words.some((word) => /^(-[cCbB]|--create|--force-create|--orphan)$/.test(word));
	return { target: words.find((word) => !word.startsWith("-")), create };
}

export function switchesBranch(command: string): boolean {
	return branchSwitch(command) !== undefined;
}

const git = (dir: string, ...args: string[]) => {
	try {
		return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return undefined;
	}
};

/** Why a branch switch in `dir` needs the user: it moves the main checkout, or puts the default branch outside it. */
export function switchViolation(command: string, dir: string): string | undefined {
	const change = branchSwitch(command);
	if (!change) return undefined;
	const gitDir = git(dir, "rev-parse", "--absolute-git-dir");
	if (gitDir === undefined) return undefined;
	if (gitDir === resolve(dir, git(dir, "rev-parse", "--git-common-dir") ?? "")) return SWITCH;
	const head = git(dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")?.replace(/^origin\//, "");
	const defaults = new Set(["main", "master", ...(head ? [head] : [])]);
	return !change.create && change.target && defaults.has(change.target) ? SWITCH : undefined;
}

interface Folder {
	path: string;
	/** Reading is allowed; only writes need the user. */
	readable?: boolean;
}

const RESTRICTED: Folder[] = [{ path: "~/.ssh" }, { path: "~/.gnupg" }, { path: "~/.config/sops" }, { path: "/etc", readable: true }];

const SECRETS: RegExp[] = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\bAGE-SECRET-KEY-1[0-9A-Z]{58}\b/g,
	/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{60,}\b/g,
	/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
	/\bsk-[A-Za-z0-9_-]{32,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	/\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
];

export function commandViolation(command: string): string | undefined {
	return COMMAND_RULES.find((rule) => rule.pattern.test(command))?.reason;
}

const expand = (path: string) => (path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path);
const variants = (folder: string) => (folder.startsWith("~/") ? [folder, `$HOME${folder.slice(1)}`, `${homedir()}${folder.slice(1)}`] : [folder]);
const escaped = (text: string) => text.replace(/[$.]/g, "\\$&");

export function restrictedFolder(path: string, cwd: string): string | undefined {
	const absolute = resolve(cwd, expand(path.replace(/^@/, "")));
	return RESTRICTED.find((folder) => {
		const root = expand(folder.path);
		return absolute === root || absolute.startsWith(`${root}/`);
	})?.path;
}

/** Whether only writes to `folder` need the user. */
export function readableFolder(folder: string): boolean {
	return RESTRICTED.some((entry) => entry.path === folder && entry.readable);
}

function commandMentionsRestricted(command: string): string | undefined {
	return RESTRICTED.find(({ path }) => variants(path).some((variant) => new RegExp(`(^|[\\s'"=:<>])${escaped(variant)}(/|\\b|$)`).test(command)))?.path;
}

/** Commands whose last argument is the destination. */
const DESTINATION_LAST = new Set(["cp", "mv", "ln", "install", "rsync", "ditto"]);
/** Commands that change every path they name. */
const CHANGES_ARGS = new Set(["rm", "rmdir", "mkdir", "touch", "chmod", "chown", "chgrp", "truncate", "tee", "patch", "shred", "unlink"]);

/** Whether `command` may write under `folder`: a redirect into it, a destination in it, or an in-place edit of a file in it. */
export function writesInto(command: string, folder: string): boolean {
	const inside = new RegExp(`^(${variants(folder).map(escaped).join("|")})(/|$)`);
	const redirect = new RegExp(`>>?\\s*['"]?(${variants(folder).map(escaped).join("|")})(/|\\b)`);
	if (redirect.test(command)) return true;
	return unquotedWords(command)
		.split(/[;&|\n]/)
		.some((segment) => {
			const words = segment.trim().split(/\s+/).filter(Boolean).map((word) => word.replace(/\u0000/g, " "));
			while (words[0] && (/^\w+=/.test(words[0]) || ["sudo", "doas", "env", "command", "exec", "nice", "time"].includes(words[0]))) words.shift();
			const [program, ...args] = words;
			if (!program) return false;
			const paths = args.filter((word) => !word.startsWith("-"));
			const name = program.split("/").at(-1) ?? program;
			if (DESTINATION_LAST.has(name)) return inside.test(paths.at(-1) ?? "");
			if (CHANGES_ARGS.has(name)) return paths.some((path) => inside.test(path));
			if (name === "dd") return args.some((arg) => inside.test(arg.replace(/^of=/, "")) && arg.startsWith("of="));
			const inPlace = (name === "sed" && args.some((arg) => /^(-i|--in-place)/.test(arg))) || (name === "perl" && args.some((arg) => /^-\w*i/.test(arg)));
			return inPlace && paths.some((path) => inside.test(path));
		});
}

export function maskSecrets(text: string): string {
	return SECRETS.reduce((masked, pattern) => masked.replace(pattern, "[redacted secret]"), text);
}

/** Seconds a guard waits for the user before it denies the call, so an unattended run does not hang. */
export const WAIT_SECONDS = 120;
const ALLOW = "Allow";
const DENY = "Deny";
const DENY_WITH_REASON = "Deny with a reason";

type Verdict = { allowed: true } | { allowed: false; why: string };

async function ask(ctx: ExtensionContext, title: string, detail: string): Promise<Verdict> {
	if (!ctx.hasUI) return { allowed: false, why: "No user is attached to approve it." };
	const started = Date.now();
	const choice = await ctx.ui.select(`${title}\n\n${detail}`, [ALLOW, DENY, DENY_WITH_REASON], { timeout: WAIT_SECONDS * 1000 });
	if (choice === ALLOW) return { allowed: true };
	// Escape also returns nothing; only a dialog that ran its full time went unanswered.
	if (choice === undefined && Date.now() - started >= WAIT_SECONDS * 1000 - 500)
		return { allowed: false, why: `Nobody answered within ${WAIT_SECONDS} seconds; the user may be away. Do not retry it; leave it for the user.` };
	const reason = choice === DENY_WITH_REASON ? (await ctx.ui.input("Why is it denied? The agent sees this.", "", { timeout: WAIT_SECONDS * 1000 }))?.trim() : undefined;
	return { allowed: false, why: reason ? `The user denied it: ${reason}` : "The user denied it." };
}

const block = (why: string, guidance: string) => ({ block: true as const, reason: `${why} ${guidance}` });

/** What the agent is told up front, so it avoids the calls that stop for the user. */
export function guardsPrompt(): string {
	const folders = RESTRICTED.map((folder) => (folder.readable ? `${folder.path} (writes only; reading is fine)` : folder.path)).join(", ");
	return [
		`These calls stop and wait for the user's approval; unattended, they are denied after ${WAIT_SECONDS} seconds. Avoid them, or ask the user first:`,
		"- Permanent installs (brew or port install, npm -g, cargo or go install, pip --user, pipx, uv tool, nix profile, nix-env). Use nix shell, nix run, or the devshell.",
		"- History rewrites: git commit --amend, rebase, reset --hard/--soft/--keep/--merge or to HEAD~, force pushes.",
		"- Switching the main checkout off its branch, or checking out the default branch anywhere else. Other branch switches in a worktree are fine; fast-forward the default branch with worktree ff_main.",
		`- Restricted folders: ${folders}.`,
		"A denial is final for this request: do not retry it another way. Follow the reason the user gave.",
	].join("\n");
}

const STATE = "guards";

export default function (pi: ExtensionAPI) {
	let enabled = true;
	const restore = (_event: unknown, ctx: ExtensionContext) => {
		const saved = ctx.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === STATE)
			.at(-1);
		enabled = saved?.type !== "custom" || (saved.data as { enabled?: boolean } | undefined)?.enabled !== false;
		ctx.ui.setStatus(STATE, enabled ? undefined : "guards off");
	};
	pi.on("session_start", restore);
	pi.on("session_tree", restore);

	pi.registerCommand(STATE, {
		description: "Show or change the install, history, branch, and folder guards for this session: /guards [on|off]",
		getArgumentCompletions: (prefix) => ["on", "off"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "on" || arg === "off") {
				enabled = arg === "on";
				pi.appendEntry(STATE, { enabled });
				ctx.ui.setStatus(STATE, enabled ? undefined : "guards off");
			} else if (arg) return ctx.ui.notify(`Expected on or off, got "${arg}"`, "error");
			ctx.ui.notify(`Guards ${enabled ? "on" : "off"}; secret masking stays on`, "info");
		},
	});

	pi.on("before_agent_start", (event) => {
		if (enabled) event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, guards: guardsPrompt() };
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		if (COMMAND_TOOLS[event.toolName] && typeof input.command === "string") {
			const command = input.command;
			if (!enabled) return;
			const violation = commandViolation(command);
			if (violation) {
				const verdict = await ask(ctx, "Allow blocked command?", `${violation}\n\n${command}`);
				if (!verdict.allowed) return block(verdict.why, violation);
			}
			// A command on another host runs elsewhere, so a path in it is not a local folder.
			if (typeof input.host === "string" && input.host.trim() !== "") return;
			const dir = typeof input.cwd === "string" ? resolve(sessionDir(ctx), input.cwd) : sessionDir(ctx);
			const switching = switchViolation(command, dir);
			if (switching) {
				const verdict = await ask(ctx, "Allow this branch switch?", command);
				if (!verdict.allowed) return block(verdict.why, switching);
			}
			const folder = commandMentionsRestricted(command) ?? (typeof input.cwd === "string" ? restrictedFolder(input.cwd, sessionDir(ctx)) : undefined);
			if (folder && (!readableFolder(folder) || writesInto(command, folder))) {
				const verdict = await ask(ctx, `Allow ${readableFolder(folder) ? "a write to" : "access to"} ${folder}?`, command);
				if (!verdict.allowed) return block(verdict.why, `${folder} is restricted.`);
			}
			return;
		}
		if (enabled && event.toolName === "transfer" && typeof input.local === "string") {
			// An upload reads the local path, a download writes it.
			const folder = restrictedFolder(input.local, sessionDir(ctx));
			if (folder && !(input.direction === "upload" && readableFolder(folder))) {
				const verdict = await ask(ctx, `Allow transfer ${input.direction === "upload" ? "from" : "into"} ${folder}?`, `${input.local} ${input.direction === "upload" ? "->" : "<-"} ${String(input.host)}:${String(input.remote)}`);
				if (!verdict.allowed) return block(verdict.why, `${folder} is restricted.`);
			}
			return;
		}
		if (enabled && PATH_TOOLS[event.toolName]) {
			const reads = READ_TOOLS[event.toolName] || (event.toolName === "substitute" && !input.apply);
			const paths = [...(typeof input.path === "string" ? [input.path] : []), ...(Array.isArray(input.paths) ? input.paths.map(String) : [])];
			for (const path of paths) {
				const folder = restrictedFolder(path, sessionDir(ctx));
				if (!folder || (reads && readableFolder(folder))) continue;
				const verdict = await ask(ctx, `Allow ${event.toolName} in ${folder}?`, path);
				if (!verdict.allowed) return block(verdict.why, `${folder} is restricted.`);
			}
		}
		if (enabled && event.toolName === "lsp" && input.apply && typeof input.token === "string") {
			// An lsp apply writes the files its preview named, sources and destinations of a move included.
			for (const path of previewPaths(input.token) ?? []) {
				const folder = restrictedFolder(path, sessionDir(ctx));
				if (!folder) continue;
				const verdict = await ask(ctx, `Allow lsp apply in ${folder}?`, path);
				if (!verdict.allowed) return block(verdict.why, `${folder} is restricted.`);
			}
		}
	});

	pi.on("tool_result", (event) => {
		let changed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text") return part;
			const text = maskSecrets(part.text);
			if (text !== part.text) changed = true;
			return { ...part, text };
		});
		if (changed) return { content };
	});
}
