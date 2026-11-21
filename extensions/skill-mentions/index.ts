import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { CustomEditor, type ExtensionAPI, type SlashCommandInfo, stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, fuzzyFilter, matchesKey, visibleWidth } from "@earendil-works/pi-tui";

const PREFIX = "skill:";
const ICON = "\uf0eb";
// The menu opens on "$" and on a mid-prompt "/skill:"; a leading "/skill:" is pi's own slash completion.
const TRIGGER = /(^|\s)(\$|\/skill:)([^\s$]*)$/;
// What `SkillEditor` adds to the editor's own trigger pattern.
const SLASH_TRIGGER = "(?:^|\\s)/skill:[\\w.-]*$";
const AT_CURSOR = /(?:^|\s)(\/skill:([\w.-]+))$/;
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

/** pi's editor, with a completed `/skill:name` drawn as one chip that Backspace deletes whole. */
class SkillEditor extends CustomEditor {
	known: () => Record<string, true> = () => ({});
	chip: (name: string) => string = (name) => name;

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		super.setAutocompleteProvider(provider);
		// The editor accepts no "/" trigger and rebuilds these two private fields from the provider's characters.
		const editor = this as unknown as { autocompleteTriggerPattern?: RegExp; autocompleteTriggerCharacters?: string[] };
		const pattern = editor.autocompleteTriggerPattern;
		if (!(pattern instanceof RegExp) || !Array.isArray(editor.autocompleteTriggerCharacters)) return;
		editor.autocompleteTriggerPattern = new RegExp(`${pattern.source}|${SLASH_TRIGGER}`, pattern.flags);
		editor.autocompleteTriggerCharacters = [...editor.autocompleteTriggerCharacters, ":"];
	}

	override handleInput(data: string): void {
		if (matchesKey(data, "backspace")) {
			const { line, col } = this.getCursor();
			const [, token, name = ""] = (this.getLines()[line] ?? "").slice(0, col).match(AT_CURSOR) ?? [];
			if (token && this.known()[name]) {
				// The half-deleted token must not open the menu, and a menu that was open must not stay on stale text.
				const editor = this as unknown as { autocompleteTriggerPattern?: RegExp };
				const pattern = editor.autocompleteTriggerPattern;
				editor.autocompleteTriggerPattern = /(?!)/;
				for (let i = 0; i < token.length; i++) super.handleInput(data);
				editor.autocompleteTriggerPattern = pattern;
				if (this.isShowingAutocomplete()) super.handleInput("\x1b");
				return;
			}
		}
		super.handleInput(data);
	}

	override render(width: number): string[] {
		const known = this.known();
		return super.render(width).map((line) => {
			// A token the cursor is inside carries the cursor's escape codes, so it stays as typed.
			const drawn = line.replace(TOKEN, (token, before: string, name: string) => (known[name] ? before + this.chip(name) : token));
			return drawn === line ? line : drawn + " ".repeat(Math.max(0, visibleWidth(line) - visibleWidth(drawn)));
		});
	}
}

/** Skills mid-prompt: `$` or `/skill:` opens a menu that inserts `/skill:name`, and every `/skill:name` in a prompt loads that skill. */
export default function (pi: ExtensionAPI) {
	const skills = () => pi.getCommands().filter((command) => command.source === "skill");
	let chip = (name: string) => `${ICON} ${name}`;

	pi.registerMarkdownTransformer((markdown) => markdown.replace(BLOCK, (_block, name: string) => chip(name)), { messageTypes: ["user"] });

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") {
			const { theme } = ctx.ui;
			chip = (name) => theme.fg("accent", `${ICON} ${name}`);
			ctx.ui.setEditorComponent((tui, editorTheme, keybindings) => {
				const editor = new SkillEditor(tui, editorTheme, keybindings);
				editor.known = () => Object.fromEntries(skills().map((skill) => [skill.name.slice(PREFIX.length), true]));
				editor.chip = chip;
				return editor;
			});
		}
		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: ["$"],
			async getSuggestions(lines, line, col, options) {
				const before = (lines[line] ?? "").slice(0, col);
				const [typed, , trigger, query] = before.match(TRIGGER) ?? [];
				const leadsMessage = lines.slice(0, line).join("").trim() === "" && before.trimStart() === typed?.trimStart();
				if (trigger === undefined || query === undefined || (trigger !== "$" && leadsMessage)) return current.getSuggestions(lines, line, col, options);
				const items = fuzzyFilter(skills(), query, (skill) => skill.name.slice(PREFIX.length)).map((skill) => ({
					value: `/${skill.name}`,
					label: skill.name.slice(PREFIX.length),
					...(skill.description && { description: skill.description }),
				}));
				return items.length > 0 ? { prefix: trigger + query, items } : null;
			},
			applyCompletion(lines, line, col, item, prefix) {
				if (!prefix.startsWith("$") && !prefix.startsWith("/skill:")) return current.applyCompletion(lines, line, col, item, prefix);
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
