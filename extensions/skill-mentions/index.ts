import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type ExtensionAPI, type SlashCommandInfo, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";

const PREFIX = "skill:";
// pi's editor refuses "/" as a provider trigger character, so the menu opens on "$".
const TRIGGER = /(?:^|\s)\$([^\s$]*)$/;
// A name ends before trailing punctuation, so `(/skill:zig).` loads zig; `/skill:zig/x` is a path.
const TOKEN = /(^|[\s([{"'`])\/skill:([\w-]+(?:\.[\w-]+)*)(?![\w/-]|\.[\w-])/g;
// pi draws only a user message's first skill block as a skill; the rest stay in the message text.
const BLOCK = /<skill name="([^"]+)" location="[^"]*">\n[\s\S]*?\n<\/skill>/g;

// Same block as pi's leading `/skill:name` expansion, so the transcript renders it as a skill.
function skillBlock(skill: SlashCommandInfo): string {
	const name = skill.name.slice(PREFIX.length);
	const body = stripFrontmatter(readFileSync(skill.sourceInfo.path, "utf-8")).trim();
	return `<skill name="${name}" location="${skill.sourceInfo.path}">\nReferences are relative to ${dirname(skill.sourceInfo.path)}.\n\n${body}\n</skill>`;
}

/** Skills mid-prompt: `$` opens a menu that inserts `/skill:name`, and every `/skill:name` in a prompt loads that skill. */
export default function (pi: ExtensionAPI) {
	const skills = () => pi.getCommands().filter((command) => command.source === "skill");

	pi.registerMarkdownTransformer((markdown) => markdown.replace(BLOCK, "`[skill] $1`"), { messageTypes: ["user"] });

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: ["$"],
			async getSuggestions(lines, line, col, options) {
				const query = (lines[line] ?? "").slice(0, col).match(TRIGGER)?.[1];
				if (query === undefined) return current.getSuggestions(lines, line, col, options);
				const items = fuzzyFilter(skills(), query, (skill) => skill.name.slice(PREFIX.length)).map((skill) => ({
					value: `/${skill.name}`,
					label: skill.name.slice(PREFIX.length),
					...(skill.description && { description: skill.description }),
				}));
				return items.length > 0 ? { prefix: `$${query}`, items } : null;
			},
			applyCompletion(lines, line, col, item, prefix) {
				if (!prefix.startsWith("$")) return current.applyCompletion(lines, line, col, item, prefix);
				const text = lines[line] ?? "";
				const start = col - prefix.length;
				const insert = `${item.value} `;
				const next = [...lines];
				next[line] = text.slice(0, start) + insert + text.slice(col);
				return { lines: next, cursorLine: line, cursorCol: start + insert.length };
			},
			shouldTriggerFileCompletion(lines, line, col) {
				return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
			},
		}));
	});

	pi.on("input", (event, ctx) => {
		// Like pi's own expansion, which skips `sendUserMessage` text by default.
		if (event.source === "extension") return;
		const text = event.text.trimStart();
		// Another slash command owns its arguments; "!" runs a shell command.
		if ((text.startsWith("/") && !text.startsWith("/skill:")) || text.startsWith("!")) return;
		const known = new Map(skills().map((skill) => [skill.name.slice(PREFIX.length), skill]));
		const lead = text.match(/^\/skill:(\S+)/)?.[1];
		const head = lead === undefined ? "" : `/skill:${lead}`;
		const body = text.slice(head.length);
		// A lone leading `/skill:name` is pi's own expansion.
		if (![...body.matchAll(TOKEN)].some(([, , name = ""]) => known.has(name))) return;
		const blocks = new Map<string, string>();
		const load = (name: string) => {
			const skill = known.get(name);
			if (!skill) return false;
			try {
				if (!blocks.has(name)) blocks.set(name, skillBlock(skill));
				return true;
			} catch (error) {
				ctx.ui.notify(`skill-mentions: cannot load ${name}: ${error instanceof Error ? error.message : String(error)}`, "error");
				return false;
			}
		};
		const kept = lead !== undefined && load(lead) ? "" : head;
		const prose = (kept + body.replace(TOKEN, (token, space: string, name: string) => (load(name) ? `${space}${name}` : token))).trim();
		if (blocks.size === 0) return;
		return { action: "transform", text: [...blocks.values(), ...(prose ? [prose] : [])].join("\n\n") };
	});
}
