import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { createGrepToolDefinition, getAgentDir } from "@earendil-works/pi-coding-agent";
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

const exec = promisify(execFile);
const DEFAULT_LIMIT = 100;

interface GrepInput {
	pattern: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
	multiline?: boolean;
}

/** ripgrep from pi's tools directory, where the builtin grep installs it, else from PATH. */
const rgPath = () => {
	const local = join(getAgentDir(), "bin", "rg");
	return existsSync(local) ? local : "rg";
};

/**
 * A multiline search with ripgrep, in the builtin's text format (`path:N: text`, `path-N- text`),
 * paths relative to the searched directory. The builtin grep has no multiline mode.
 */
async function multilineGrep(target: string, input: GrepInput, signal?: AbortSignal): Promise<string> {
	const isDirectory = statSync(target).isDirectory();
	// Separators no path or line holds, so a path with `-12-` or `:3:` in it parses.
	const args = ["--no-config", "--line-number", "--no-heading", "--with-filename", "--color=never", "--multiline", "--multiline-dotall", "--hidden"];
	args.push("--field-match-separator", "\x1e", "--field-context-separator", "\x1f");
	if (input.ignoreCase) args.push("--ignore-case");
	if (input.literal) args.push("--fixed-strings");
	if (input.glob) args.push("--glob", input.glob.replace(/^(!?)(?:\.\/)+/, "$1"));
	if (input.context) args.push("--context", String(input.context));
	args.push("--", input.pattern, isDirectory ? "." : basename(target));
	const out = await exec(rgPath(), args, { cwd: isDirectory ? target : dirname(target), maxBuffer: 64 * 1024 * 1024, signal }).then(
		(r) => r.stdout,
		(error: Error & { code?: number; stdout?: string; stderr?: string }) => {
			if (error.code === 1) return "";
			throw new Error((error.stderr || error.message).trim());
		},
	);
	const limit = input.limit ?? DEFAULT_LIMIT;
	const rows: string[] = [];
	let matches = 0;
	for (const row of out.split("\n")) {
		const match = /^([^\x1e\x1f]*)\x1e(\d+)\x1e(.*)$/.exec(row);
		const context = match ? undefined : /^([^\x1e\x1f]*)\x1f(\d+)\x1f(.*)$/.exec(row);
		const hit = match ?? context;
		if (!hit) continue;
		if (match && ++matches > limit) break;
		rows.push(`${hit[1]?.replace(/^\.\//, "")}${match ? ":" : "-"}${hit[2]}${match ? ": " : "- "}${hit[3]}`);
	}
	if (rows.length === 0) return "No matches found";
	return matches > limit ? `${rows.join("\n")}\n\n[${limit} matches limit reached. Use limit=${limit * 2} for more, or refine pattern]` : rows.join("\n");
}

/** pi's grep, plus `structuredContent` whose paths resolve against the working directory, and a multiline mode. */
export function structuredGrep(dir: string): ReturnType<typeof createGrepToolDefinition> {
	const builtin = createGrepToolDefinition(dir);
	const parameters = Type.Object({
		...builtin.parameters.properties,
		multiline: Type.Optional(Type.Boolean({ description: "Let the pattern span lines: \\n matches a newline and . matches it too (default: false)" })),
	});
	return {
		...builtin,
		parameters: parameters as unknown as typeof builtin.parameters,
		description: `${builtin.description} Use instead of grep or rg in a shell. Scripts get { lines: [{ path, line, text, match }], files, notice? }.`,
		outputSchema,
		async execute(id, input, signal, onUpdate, ctx) {
			const target = resolve(dir, typeof input.path === "string" ? input.path.replace(/^@/, "") : ".");
			const options = input as GrepInput;
			if (options.multiline && !existsSync(target)) throw new Error(`Path not found: ${target}`);
			const result = options.multiline
				? { content: [{ type: "text" as const, text: await multilineGrep(target, options, signal) }], details: undefined }
				: await builtin.execute(id, input, signal, onUpdate, ctx);
			const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
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
