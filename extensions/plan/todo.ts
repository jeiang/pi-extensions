import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

/** The session entry naming the file the progress list lives in: an approved plan, or the session's todo.md. */
export const LIST = "todo";

export interface Step {
	id: number;
	done: boolean;
	text: string;
	/** Index of the step's line in the file. */
	line: number;
}

const CHECKBOX = /^(\s*[-*] )\[( |x|X)\] (.*)$/;

/** The checklist items of a markdown file, numbered from 1 in file order. */
export function parseSteps(text: string): Step[] {
	const steps: Step[] = [];
	text.split("\n").forEach((row, line) => {
		const match = CHECKBOX.exec(row);
		if (match) steps.push({ id: steps.length + 1, done: match[2] !== " ", text: match[3] ?? "", line });
	});
	return steps;
}

/** `text` with step `id` checked or unchecked. */
export function setDone(text: string, id: number, done: boolean): string {
	const step = parseSteps(text).find((candidate) => candidate.id === id);
	if (!step) throw new Error(`No step ${id}; the list has ${parseSteps(text).length}.`);
	const rows = text.split("\n");
	rows[step.line] = (rows[step.line] ?? "").replace(CHECKBOX, (_m, lead: string, _mark: string, rest: string) => `${lead}[${done ? "x" : " "}] ${rest}`);
	return rows.join("\n");
}

/** `text` with a new unchecked step after the last one, or at the end. */
export function addStep(text: string, item: string): string {
	const steps = parseSteps(text);
	const rows = text.replace(/\n$/, "").split("\n").filter((row, i, all) => !(all.length === 1 && row === ""));
	const at = steps.length > 0 ? (steps.at(-1)?.line ?? rows.length - 1) + 1 : rows.length;
	rows.splice(at, 0, `- [ ] ${item.replace(/\n/g, " ")}`);
	return `${rows.join("\n")}\n`;
}

/** One line for the footer: done of all, and the next open step. */
export function progressLine(steps: Step[]): string | undefined {
	if (steps.length === 0) return undefined;
	const done = steps.filter((step) => step.done).length;
	const next = steps.find((step) => !step.done);
	return next ? `☐ ${done}/${steps.length} · ${next.text.slice(0, 48)}` : `☑ ${done}/${steps.length}`;
}

export const renderSteps = (steps: Step[]) => steps.map((step) => `${step.id}. [${step.done ? "x" : " "}] ${step.text}`).join("\n");

type Entry = { type: string; customType?: string; data?: unknown };

/** The list's file: the last one the session pointed at, else todo.md in the session's directory. */
export function todoFile(entries: Entry[], sessionFile: string | undefined, sessionId = "unsaved"): string {
	const pointed = entries.filter((entry) => entry.type === "custom" && entry.customType === LIST).at(-1)?.data as { file?: string } | undefined;
	if (pointed?.file) return pointed.file;
	return sessionFile ? join(sessionFile.replace(/\.jsonl$/, ""), "todo.md") : join(tmpdir(), "pi-todo", sessionId, "todo.md");
}

export const readSteps = (file: string): Step[] => (existsSync(file) ? parseSteps(readFileSync(file, "utf8")) : []);

/** The checkout's branch and changed paths; empty outside a repository. */
export function gitSummary(cwd: string): string {
	const git = (args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	try {
		const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
		const dirty = git(["status", "--short"]).trim();
		return dirty ? `${branch}\n${dirty}` : `${branch} (clean)`;
	} catch {
		return "";
	}
}

/** The `todo` tool, `/todos`, `/status`, the footer line, and the open steps a resumed session starts with. */
export function registerTodo(pi: ExtensionAPI) {
	const fileOf = (ctx: ExtensionContext) => todoFile(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId());
	const show = (ctx: ExtensionContext) => ctx.ui.setStatus(LIST, progressLine(readSteps(fileOf(ctx))));

	pi.registerTool({
		name: LIST,
		label: "Todo",
		description:
			"The progress list the user sees: an approved plan's checklist, or the session's own list. list shows it; add appends a step; toggle checks or unchecks one by id; clear starts an empty session list. Check off each step as you finish it.",
		promptSnippet: "Track progress the user sees: list, add, toggle, clear",
		parameters: Type.Object({
			action: StringEnum(["list", "add", "toggle", "clear"] as const),
			text: Type.Optional(Type.String({ description: "add: the step." })),
			id: Type.Optional(Type.Number({ description: "toggle: the step's number from list." })),
		}),
		async execute(_id, input, _signal, _onUpdate, ctx) {
			let file = fileOf(ctx);
			if (input.action === "clear") {
				file = todoFile([], ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId());
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, "");
				pi.appendEntry(LIST, { file });
			} else if (input.action === "add") {
				if (!input.text?.trim()) throw new Error("add needs text.");
				mkdirSync(dirname(file), { recursive: true });
				writeFileSync(file, addStep(existsSync(file) ? readFileSync(file, "utf8") : "", input.text.trim()));
			} else if (input.action === "toggle") {
				if (input.id === undefined) throw new Error("toggle needs id.");
				const text = existsSync(file) ? readFileSync(file, "utf8") : "";
				const step = parseSteps(text).find((candidate) => candidate.id === input.id);
				writeFileSync(file, setDone(text, input.id, !step?.done));
			}
			show(ctx);
			const steps = readSteps(file);
			return { content: [{ type: "text", text: `${file}\n${renderSteps(steps) || "(empty)"}` }], details: { file, steps } };
		},
	});

	pi.registerCommand("todos", {
		description: "Show the progress list",
		handler: async (_args, ctx) => {
			const file = fileOf(ctx);
			ctx.ui.notify(`${file}\n${renderSteps(readSteps(file)) || "No steps yet."}`, "info");
		},
	});

	pi.registerCommand("status", {
		description: "Show the progress list and the checkout's branch and changes",
		handler: async (_args, ctx) => {
			const steps = readSteps(fileOf(ctx));
			const git = gitSummary(ctx.cwd);
			const parts = [steps.length ? `Progress (${progressLine(steps)}):\n${renderSteps(steps)}` : "No progress list yet.", git ? `Checkout:\n${git}` : ""];
			ctx.ui.notify(parts.filter(Boolean).join("\n\n"), "info");
		},
	});

	pi.on("session_start", (event, ctx) => {
		show(ctx);
		// A resumed or forked session opens with the steps still open, instead of re-deriving them.
		if (event.reason !== "resume" && event.reason !== "fork") return;
		const file = fileOf(ctx);
		const open = readSteps(file).filter((step) => !step.done);
		if (open.length === 0) return;
		pi.sendMessage({ customType: LIST, content: `[resumed session] Open steps in ${file}:\n${renderSteps(open)}`, display: true }, {});
	});
	pi.on("session_tree", (_event, ctx) => show(ctx));
}
