import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createFindToolDefinition, createLsToolDefinition, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const notice = Type.Optional(Type.String({ description: "Why results were cut, if they were." }));
const lsSchema = Type.Object({ entries: Type.Array(Type.String(), { description: "Names, sorted; directories end in '/'." }), notice });
const findSchema = Type.Object({ paths: Type.Array(Type.String(), { description: "Matching paths, relative to the searched directory." }), notice });

/** Splits pi's listing text, one item per line and then an optional `[notice]`; `empty` is its text for no items. */
export function parseListing(text: string, empty: string): { items: string[]; notice?: string } {
	if (text === empty) return { items: [] };
	const cut = /\n\n\[([^\n]*)\]$/.exec(text);
	const items = (cut ? text.slice(0, cut.index) : text).split("\n").filter(Boolean);
	return { items, ...(cut?.[1] ? { notice: cut[1] } : {}) };
}

const textOf = (content: { type: string; text?: string }[]) => content.map((part) => (part.type === "text" ? part.text : "")).join("");

/** pi's ls, plus `structuredContent` for scripts. */
export function structuredLs(dir: string): ReturnType<typeof createLsToolDefinition> {
	const builtin = createLsToolDefinition(dir);
	return {
		...builtin,
		description: `${builtin.description} Scripts get { entries, notice? }.`,
		outputSchema: lsSchema,
		async execute(id, input, signal, onUpdate, ctx) {
			const result = await builtin.execute(id, input, signal, onUpdate, ctx);
			const { items, notice } = parseListing(textOf(result.content), "(empty directory)");
			return { ...result, structuredContent: { entries: items, ...(notice ? { notice } : {}) } };
		},
	};
}

/** pi's find, plus `structuredContent` for scripts. */
export function structuredFind(dir: string): ReturnType<typeof createFindToolDefinition> {
	const builtin = createFindToolDefinition(dir);
	return {
		...builtin,
		description: `${builtin.description} Scripts get { paths, notice? }.`,
		outputSchema: findSchema,
		async execute(id, input, signal, onUpdate, ctx) {
			const result = await builtin.execute(id, input, signal, onUpdate, ctx);
			const { items, notice } = parseListing(textOf(result.content), "No files found matching pattern");
			return { ...result, structuredContent: { paths: items, ...(notice ? { notice } : {}) } };
		},
	};
}

const MAX_TEXT_BYTES = 1024 * 1024;
const readTextParams = Type.Object({ path: Type.String({ description: "File path, relative to the working directory or absolute." }) });
const readTextSchema = Type.Object({
	text: Type.String({ description: "The whole file, with \\r\\n turned into \\n." }),
	lines: Type.Number({ description: "Line count." }),
});

/** A file's raw text for scripts, which cannot use the numbered rows `read` gives the model. */
export function readTextTool(dir: string): ToolDefinition<typeof readTextParams> {
	return {
		name: "read_text",
		label: "Read text",
		description: `A text file's raw contents, for scripts to parse or transform (up to 1 MiB; use read with ranges for more). Scripts get { text, lines }; write a changed file back with write, or change one passage with replace.`,
		parameters: readTextParams,
		outputSchema: readTextSchema,
		async execute(_id, input) {
			const absolute = resolve(dir, input.path.replace(/^@/, ""));
			const { size } = await stat(absolute);
			if (size > MAX_TEXT_BYTES) throw new Error(`${input.path} is ${size} bytes, over 1 MiB; use read with ranges or offset/limit.`);
			const text = (await readFile(absolute, "utf8")).replace(/\r\n?/g, "\n");
			const lines = text === "" ? 0 : text.replace(/\n$/, "").split("\n").length;
			return { content: [{ type: "text", text }], details: undefined, structuredContent: { text, lines } };
		},
	};
}
