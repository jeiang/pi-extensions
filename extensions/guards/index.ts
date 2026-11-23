import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionDir } from "../workspace/cwd.ts";

interface Rule {
	pattern: RegExp;
	reason: string;
}

const COMMAND_TOOLS: Record<string, true> = { bash: true, shell: true, ssh: true };
/** Their commands run elsewhere, so a path in them is not a local folder. */
const REMOTE_TOOLS: Record<string, true> = { ssh: true };
const PATH_TOOLS: Record<string, true> = { read: true, read_text: true, write: true, edit: true, replace: true, substitute: true, grep: true, find: true, ls: true };

const INSTALL = "Permanent installs are not allowed. Use `nix shell nixpkgs#<pkg> -c <cmd>` or `nix run`, or add the tool to the repository's devshell.";
const HISTORY = "Rewriting git history needs the user's explicit request.";
const PIPED =
	"Piping output into tail, head, or grep keeps only part of it, and the log then holds only that part. Drop the pipe: pass tail: N for the end, then read the log named in the result (offset/limit, negative offset for the end) or grep it.";

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
	"Switching branches moves the checkout the session works in. Use the worktree tool: enter for an existing branch, create for a new one. To read another revision use git show, diff, or log <rev>; to build or test one, git worktree add --detach <dir> <rev> and work there.";

/** Habits with a better tool: blocked with the redirect at once, never put to the user. */
export const HABIT_RULES: Rule[] = [{ pattern: /2>&1\s*\|\s*(tail|head|grep)\b/, reason: PIPED }];
/** Habits that matter only on this machine, not in a command run over ssh. A `--` pathspec restores files, which is fine. */
const LOCAL_HABIT_RULES: Rule[] = [{ pattern: /\bgit\s+(-C\s+\S+\s+)?(switch\b|checkout\b(?![^|;&\n]*\s--(\s|$)))/, reason: SWITCH }];

const RESTRICTED = ["~/.ssh", "~/.gnupg", "~/.config/sops", "/etc"];

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

export function commandHabit(command: string, remote = false): string | undefined {
	return [...HABIT_RULES, ...(remote ? [] : LOCAL_HABIT_RULES)].find((rule) => rule.pattern.test(command))?.reason;
}

const expand = (path: string) => (path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path);

export function restrictedFolder(path: string, cwd: string): string | undefined {
	const absolute = resolve(cwd, expand(path.replace(/^@/, "")));
	return RESTRICTED.find((folder) => {
		const root = expand(folder);
		return absolute === root || absolute.startsWith(`${root}/`);
	});
}

function commandMentionsRestricted(command: string): string | undefined {
	const home = homedir();
	return RESTRICTED.find((folder) => {
		const variants = folder.startsWith("~/")
			? [folder, `$HOME${folder.slice(1)}`, `${home}${folder.slice(1)}`]
			: [folder];
		return variants.some((variant) => new RegExp(`(^|[\\s'"=:])${variant.replace(/[$.]/g, "\\$&")}(/|\\b|$)`).test(command));
	});
}

export function maskSecrets(text: string): string {
	return SECRETS.reduce((masked, pattern) => masked.replace(pattern, "[redacted secret]"), text);
}

async function allow(ctx: ExtensionContext, title: string, detail: string): Promise<boolean> {
	if (!ctx.hasUI) return false;
	return ctx.ui.confirm(title, detail);
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		if (COMMAND_TOOLS[event.toolName] && typeof input.command === "string") {
			const command = input.command;
			const habit = commandHabit(command, Boolean(REMOTE_TOOLS[event.toolName]));
			if (habit) return { block: true, reason: habit };
			const violation = commandViolation(command);
			if (violation && !(await allow(ctx, "Allow blocked command?", `${violation}\n\n${command}`))) {
				return { block: true, reason: `${violation} If the user asked for it, ask them to run it.` };
			}
			if (REMOTE_TOOLS[event.toolName]) return;
			const folder = commandMentionsRestricted(command) ?? (typeof input.cwd === "string" ? restrictedFolder(input.cwd, sessionDir(ctx)) : undefined);
			if (folder && !(await allow(ctx, `Allow access to ${folder}?`, command))) {
				return { block: true, reason: `${folder} is restricted. Ask the user before touching it.` };
			}
			return;
		}
		if (PATH_TOOLS[event.toolName]) {
			const paths = [...(typeof input.path === "string" ? [input.path] : []), ...(Array.isArray(input.paths) ? input.paths.map(String) : [])];
			for (const path of paths) {
				const folder = restrictedFolder(path, sessionDir(ctx));
				if (folder && !(await allow(ctx, `Allow ${event.toolName} in ${folder}?`, path))) {
					return { block: true, reason: `${folder} is restricted. Ask the user before touching it.` };
				}
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
