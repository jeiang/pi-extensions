import { statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createGrepToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const line = Type.Object({ path: Type.String(), line: Type.Number(), text: Type.String(), match: Type.Boolean() });
const outputSchema = Type.Object({
	lines: Type.Array(line, { description: "Matches and, with context, the lines around them, in output order." }),
	files: Type.Array(Type.String(), { description: "Files with at least one match." }),
	notice: Type.Optional(Type.String({ description: "Why results were cut, if they were." })),
});
type Output = Static<typeof outputSchema>;

/**
 * Parses pi's grep text: `path:N: text` for matches, `path-N- text` for context, then an optional `[notice]`.
 * The separator found first wins, so a colon inside a context line's text is not read as a match.
 */
export function parseGrep(text: string): Output {
	if (text === "No matches found") return { lines: [], files: [] };
	const notice = /\n\n\[([^\n]*)\]$/.exec(text);
	const body = notice ? text.slice(0, notice.index) : text;
	const lines: Output["lines"] = [];
	for (const row of body.split("\n")) {
		const match = /:(\d+): /.exec(row);
		const context = /-(\d+)- /.exec(row);
		const hit = match && (!context || match.index <= context.index) ? match : context;
		if (!hit?.[1]) continue;
		lines.push({ path: row.slice(0, hit.index), line: Number(hit[1]), text: row.slice(hit.index + hit[0].length), match: hit === match });
	}
	const files = [...new Set(lines.filter((l) => l.match).map((l) => l.path))];
	return { lines, files, ...(notice?.[1] ? { notice: notice[1] } : {}) };
}

/** pi's grep, plus `structuredContent` whose paths resolve against the working directory. */
export function structuredGrep(dir: string): ReturnType<typeof createGrepToolDefinition> {
	const builtin = createGrepToolDefinition(dir);
	return {
		...builtin,
		description: `${builtin.description} Use instead of grep or rg in a shell. Scripts get { lines: [{ path, line, text, match }], files, notice? }.`,
		outputSchema,
		async execute(id, input, signal, onUpdate, ctx) {
			const result = await builtin.execute(id, input, signal, onUpdate, ctx);
			const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			const target = resolve(dir, typeof input.path === "string" ? input.path.replace(/^@/, "") : ".");
			const base = statSync(target, { throwIfNoEntry: false })?.isDirectory() ? target : dirname(target);
			const parsed = parseGrep(text);
			const shown = (path: string) => {
				const absolute = join(base, path);
				const rel = relative(dir, absolute);
				return rel.startsWith("..") || isAbsolute(rel) ? absolute : rel;
			};
			const structured: Output = {
				...parsed,
				lines: parsed.lines.map((l) => ({ ...l, path: shown(l.path) })),
				files: parsed.files.map(shown),
			};
			return { ...result, structuredContent: structured };
		},
	};
}
