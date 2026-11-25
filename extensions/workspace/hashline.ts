import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";
import {
	createReadToolDefinition,
	createWriteToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type ExtensionToolContext,
	type ReadToolDetails,
	renderDiff,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	EditSession,
	type EditStore,
	type EditWriteRequest,
	editDescription,
	hashlineFormatHeader,
	hashlineFormatNumberedLines,
} from "@oh-my-pi/pi-natives";
import { withFileLocks } from "./mutation.ts";
import { type Static, Type } from "typebox";

const IMAGE = /^\.(png|jpe?g|gif|webp|bmp|svg)$/i;
// pi exports no name for the write tool's schema.
type WriteTool = ReturnType<typeof createWriteToolDefinition>;

const readParams = Type.Object({
	path: Type.String({ description: "File path, relative to the working directory or absolute." }),
	offset: Type.Optional(Type.Number({ description: "First line to show (1-based); negative counts from the end (-50 shows the last 50 lines)." })),
	limit: Type.Optional(Type.Number({ description: "Number of lines to show." })),
	ranges: Type.Optional(
		Type.Array(Type.Object({ start: Type.Number(), end: Type.Number() }), {
			description: "Several 1-based inclusive line ranges of the file in one read, instead of offset/limit.",
		}),
	),
});

const editParams = Type.Object({
	input: Type.String({ description: "Hashline patch, as described above." }),
});

const displayPath = (absolute: string, cwd: string) => {
	const rel = relative(cwd, absolute);
	return rel.startsWith("..") || isAbsolute(rel) ? absolute : rel;
};

/** Inclusive 1-based windows to show: `ranges` sorted and merged, else one window from `offset`/`limit`. */
function windows(input: Static<typeof readParams>, total: number): [number, number][] {
	if (input.ranges?.length) {
		const sorted = input.ranges
			.map(({ start, end }) => [Math.max(1, Math.floor(start)), Math.min(total, Math.floor(end))] as [number, number])
			.filter(([start, end]) => start <= end)
			.sort((a, b) => a[0] - b[0]);
		const merged: [number, number][] = [];
		for (const range of sorted) {
			const last = merged.at(-1);
			if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
			else merged.push(range);
		}
		if (merged.length === 0) throw new Error(`No range falls inside the file (${total} lines)`);
		return merged;
	}
	const offset = Math.floor(input.offset ?? 1);
	const start = offset < 0 ? Math.max(1, total + offset + 1) : Math.max(1, offset);
	if (start > total && total > 0) throw new Error(`offset ${start} is past the end of the file (${total} lines)`);
	const wanted = input.limit === undefined ? total : Math.max(1, Math.floor(input.limit));
	return [[start, Math.min(total, start + wanted - 1)]];
}

/** Text for the model: whole-file snapshot tag in the header, `N:` numbered rows of the requested windows, `…` between them. */
export async function hashlineRead(store: EditStore, cwd: string, input: Static<typeof readParams>): Promise<string> {
	const absolute = resolve(cwd, input.path.replace(/^@/, ""));
	const text = (await readFile(absolute, "utf8")).replace(/\r\n?/g, "\n");
	const tag = store.recordSnapshot(absolute, text);
	const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
	const parts: string[] = [];
	let shownLines = 0;
	let bytes = 0;
	let cut: string | undefined;
	for (const [start, end] of windows(input, lines.length)) {
		const shown: string[] = [];
		for (let i = start - 1; i < end; i++) {
			const line = lines[i] ?? "";
			bytes += Buffer.byteLength(line) + 1;
			if (shownLines >= DEFAULT_MAX_LINES || (bytes > DEFAULT_MAX_BYTES && shownLines > 0)) {
				cut = `\n\n[Showing up to line ${start + shown.length - 1} of ${lines.length}. Use offset=${start + shown.length} to continue]`;
				break;
			}
			shown.push(line);
			shownLines++;
		}
		if (shown.length > 0) {
			const body = hashlineFormatNumberedLines(shown.join("\n"), start);
			store.recordSeenLinesFromBody(absolute, tag, body);
			parts.push(body);
		}
		if (cut) break;
	}
	return `${hashlineFormatHeader(displayPath(absolute, cwd), tag)}\n${parts.join("\n…\n")}${cut ?? ""}`;
}

async function writeRequest(request: EditWriteRequest): Promise<{ written: string }> {
	if (request.op === "delete") {
		await unlink(request.path);
		return { written: "" };
	}
	const target = request.op === "move" && request.moveTo ? request.moveTo : request.path;
	const content = request.content ?? "";
	await mkdir(dirname(target), { recursive: true });
	await writeFile(target, content);
	if (request.op === "move" && request.moveTo) await unlink(request.path);
	return { written: content };
}

const replaceParams = Type.Object({
	path: Type.String({ description: "File path, relative to the working directory or absolute." }),
	old_string: Type.String({ description: "Exact text to replace, whitespace included; it must occur once unless replace_all." }),
	new_string: Type.String({ description: "Replacement text." }),
	replace_all: Type.Optional(Type.Boolean({ description: "Replace every occurrence instead of requiring exactly one." })),
});

/** The files a patch writes, resolved against `cwd`: the ones it names, a rename's destination, or a replace's one path. */
export function patchTargets(cwd: string, mode: "hashline" | "replace", input: Record<string, unknown>): string[] {
	if (mode === "replace") return [String(input.path ?? "")].filter(Boolean).map((path) => resolve(cwd, path.replace(/^@/, "")));
	const patch = String(input.input ?? "");
	const paths = [...patch.matchAll(/\[([^\]#\n]+)#/g)].map((match) => match[1] ?? "");
	// A rename writes a file no header names; the destination must be locked with the rest.
	for (const match of patch.matchAll(/^MV\s+(.+)$/gm)) paths.push((match[1] ?? "").replace(/^"(.*)"$/, "$1"));
	return paths.filter(Boolean).map((path) => resolve(cwd, path.replace(/^@/, "")));
}
/** Runs one native edit session; matching is always exact. */
async function applyEditNow(store: EditStore, cwd: string, mode: "hashline" | "replace", input: Record<string, unknown>) {
	const session = new EditSession(store, {
		cwd,
		mode,
		allowFuzzy: false,
		fuzzyThreshold: 0.95,
		enforceSeenLines: true,
		maxColumns: 0,
		blockAutoGenerated: true,
		planActive: false,
		urlSchemes: [],
		urlAliasSchemes: [],
		planWritableRoots: [],
		homeDir: homedir(),
		rawInput: false,
	});
	try {
		session.setArgsJson(JSON.stringify(input));
		session.finish();
		const outcome = await session.apply({ lspFlush: false }, (error, request) => {
			if (error) throw error;
			return writeRequest(request);
		});
		const first = outcome.files[0];
		// pi-lsp attaches diagnostics to edit results through `input.path`.
		if (first) Object.assign(input, { path: first.path });
		return {
			content: [{ type: "text" as const, text: outcome.text }],
			details: {
				// The native engine separates line numbers with "|"; pi's diff renderer expects a space.
				diff: outcome.files.map((file) => file.diff.replace(/^([ +-]\s*\d+)\|/gm, "$1 ")).join("\n"),
				firstChangedLine: first?.firstChangedLine,
			},
			isError: outcome.isError,
		};
	} finally {
		session.close();
	}
}
type EditDetails = { diff: string; firstChangedLine?: number };

/** Serialized on the files it names, so two calls on one file cannot interleave their read and write. */
async function applyEdit(store: EditStore, cwd: string, mode: "hashline" | "replace", input: Record<string, unknown>) {
	const work = () => applyEditNow(store, cwd, mode, input);
	const targets = patchTargets(cwd, mode, input);
	return targets.length > 0 ? withFileLocks(targets, work) : work();
}

export function hashlineTools(store: EditStore) {
	const description = editDescription("hashline");
	return {
		read: (cwd: string): ToolDefinition<typeof readParams, ReadToolDetails | undefined> => {
			const builtin = createReadToolDefinition(cwd);
			return {
				...builtin,
				parameters: readParams,
				description: `${builtin.description}\n\nText files come back as a \`[path#TAG]\` header and \`N:\` numbered rows; edit anchors on both.`,
				async execute(id, input, signal, onUpdate, ctx: ExtensionToolContext) {
					const absolute = resolve(cwd, input.path.replace(/^@/, ""));
					const info = await stat(absolute);
					if (IMAGE.test(extname(absolute)) || info.isDirectory()) return builtin.execute(id, input, signal, onUpdate, ctx);
					return { content: [{ type: "text", text: await hashlineRead(store, cwd, input) }], details: undefined };
				},
			};
		},
		edit: (cwd: string): ToolDefinition<typeof editParams, EditDetails> => ({
			name: "edit",
			label: "Edit",
			description,
			promptSnippet: "Edit files with hashline patches anchored on read tags",
			parameters: editParams,
			execute: (_id, input) => applyEdit(store, cwd, "hashline", input),
			renderCall(args, theme) {
				const header = /\[([^\]#]+)#/.exec(args.input ?? "")?.[1] ?? "";
				return new Text(`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", header)}`, 0, 0);
			},
			renderResult(result, _options, theme) {
				const diff = result.details?.diff;
				const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
				return new Text(diff ? renderDiff(diff) : theme.fg("muted", text), 0, 0);
			},
		}),
		replace: (cwd: string): ToolDefinition<typeof replaceParams, EditDetails> => ({
			name: "replace",
			label: "Replace",
			description:
				"Replace exact text in one file, without line numbers. old_string must match exactly once (whitespace included) unless replace_all; read the file first. Use instead of sed -i or a python heredoc for a text replacement.",
			promptSnippet: "Replace exact text in a file (instead of sed -i)",
			parameters: replaceParams,
			execute: (_id, input) => applyEdit(store, cwd, "replace", input),
			renderCall(args, theme) {
				return new Text(`${theme.fg("toolTitle", theme.bold("replace"))} ${theme.fg("accent", args.path ?? "")}`, 0, 0);
			},
			renderResult(result, _options, theme) {
				const diff = result.details?.diff;
				const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
				return new Text(diff ? renderDiff(diff) : theme.fg("muted", text), 0, 0);
			},
		}),
		write: (cwd: string): WriteTool => {
			const builtin = createWriteToolDefinition(cwd);
			return {
				...builtin,
				async execute(id, input, signal, onUpdate, ctx) {
					const result = await builtin.execute(id, input, signal, onUpdate, ctx);
					const absolute = resolve(cwd, input.path.replace(/^@/, ""));
					const tag = store.recordSnapshot(absolute, input.content.replace(/\r\n?/g, "\n"), []);
					result.content.push({ type: "text", text: hashlineFormatHeader(displayPath(absolute, cwd), tag) });
					return result;
				},
			};
		},
	};
}
