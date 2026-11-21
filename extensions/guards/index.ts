import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sessionDir } from "../workspace/cwd.ts";

interface Rule {
	pattern: RegExp;
	reason: string;
}

const COMMAND_TOOLS: Record<string, true> = { bash: true, shell: true };
const PATH_TOOLS: Record<string, true> = { read: true, write: true, edit: true, grep: true, find: true, ls: true };

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
			const violation = commandViolation(command);
			if (violation && !(await allow(ctx, "Allow blocked command?", `${violation}\n\n${command}`))) {
				return { block: true, reason: `${violation} If the user asked for it, ask them to run it.` };
			}
			const folder = commandMentionsRestricted(command);
			if (folder && !(await allow(ctx, `Allow access to ${folder}?`, command))) {
				return { block: true, reason: `${folder} is restricted. Ask the user before touching it.` };
			}
			return;
		}
		if (PATH_TOOLS[event.toolName] && typeof input.path === "string") {
			const folder = restrictedFolder(input.path, sessionDir(ctx));
			if (folder && !(await allow(ctx, `Allow ${event.toolName} in ${folder}?`, input.path))) {
				return { block: true, reason: `${folder} is restricted. Ask the user before touching it.` };
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
