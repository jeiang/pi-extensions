import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TextEdit, WorkspaceEdit } from "vscode-languageserver-protocol";
import { recordWritten, withFileLocks } from "../workspace/mutation.ts";
import type { Encoding } from "./client.ts";
import { displayPath, lines, offsetAt } from "./text.ts";

const BOM = "\ufeff";
const MAX_SAMPLES = 3;

/** One file a preview changes: `before` and `after` are its full text (BOM kept); a rename moves it from `from`. */
export interface FileChange {
	path: string;
	before?: string;
	after?: string;
	from?: string;
	/** The source's content when the preview was made. */
	fromBefore?: string;
	delete?: boolean;
	edits: number;
}

export interface Preview {
	token: string;
	label: string;
	changes: FileChange[];
	/** Every path apply writes, creates, moves, or deletes, for the guards that check them first. */
	paths: string[];
	/** Runs after a successful apply, such as telling the server files moved. */
	after?: () => Promise<void>;
}

// Previews outlive one tool call; the workspace's effects read them to know what apply will write.
const KEY = Symbol.for("pi-extensions.lsp.previews");
const holder = globalThis as typeof globalThis & { [KEY]?: Map<string, Preview> };
const previews = (holder[KEY] ??= new Map<string, Preview>());

export const previewPaths = (token: string) => previews.get(token)?.paths;

const uriPath = (uri: string) => fileURLToPath(uri);

async function current(path: string): Promise<string | undefined> {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

/** Applies server text edits to `text`; the BOM is outside the server's coordinates and stays. */
export function applyTextEdits(text: string, edits: TextEdit[], encoding: Encoding): string {
	const bom = text.startsWith(BOM) ? BOM : "";
	const body = text.slice(bom.length);
	const spans = edits
		.map((edit, order) => ({ start: offsetAt(body, edit.range.start, encoding), end: offsetAt(body, edit.range.end, encoding), text: edit.newText, order }))
		.sort((a, b) => b.start - a.start || b.order - a.order);
	let out = body;
	let floor = Number.POSITIVE_INFINITY;
	for (const span of spans) {
		if (span.end > floor) throw new Error("The server sent overlapping edits.");
		out = out.slice(0, span.start) + span.text + out.slice(span.end);
		floor = span.start;
	}
	return bom + out;
}

/** The files a workspace edit changes, computed in memory against their current content. */
export async function planWorkspaceEdit(edit: WorkspaceEdit, encoding: Encoding): Promise<FileChange[]> {
	const changes = new Map<string, FileChange>();
	const order: FileChange[] = [];
	const entry = async (path: string) => {
		let change = changes.get(path);
		if (!change) {
			const before = await current(path);
			change = { path, before, after: before, edits: 0 };
			changes.set(path, change);
			order.push(change);
		}
		return change;
	};
	const editFile = async (uri: string, edits: TextEdit[]) => {
		const change = await entry(uriPath(uri));
		if (change.after === undefined) throw new Error(`${change.path} does not exist.`);
		change.after = applyTextEdits(change.after, edits, encoding);
		change.edits += edits.length;
	};
	for (const [uri, edits] of Object.entries(edit.changes ?? {})) await editFile(uri, edits);
	for (const op of edit.documentChanges ?? []) {
		if ("textDocument" in op) await editFile(op.textDocument.uri, op.edits as TextEdit[]);
		else if (op.kind === "create") {
			const change = await entry(uriPath(op.uri));
			if (change.after !== undefined && !op.options?.overwrite) {
				if (op.options?.ignoreIfExists) continue;
				throw new Error(`${change.path} already exists.`);
			}
			change.after = "";
		} else if (op.kind === "rename") {
			const source = await entry(uriPath(op.oldUri));
			const target = uriPath(op.newUri);
			if (existsSync(target) && !op.options?.overwrite) {
				if (op.options?.ignoreIfExists) continue;
				throw new Error(`${target} already exists.`);
			}
			if (source.after === undefined) throw new Error(`${source.path} does not exist.`);
			const moved: FileChange = { path: target, from: source.path, fromBefore: source.before, before: await current(target), after: source.after, edits: source.edits };
			changes.delete(source.path);
			order.splice(order.indexOf(source), 1, moved);
			changes.set(target, moved);
		} else if (op.kind === "delete") {
			const change = await entry(uriPath(op.uri));
			if (change.after === undefined && op.options?.ignoreIfNotExists) continue;
			change.delete = true;
			change.after = undefined;
		}
	}
	return order.filter((change) => change.delete || change.from || change.before !== change.after);
}

/** Stores a preview of `changes` and returns it with its token. */
export function storePreview(label: string, changes: FileChange[], after?: () => Promise<void>): Preview {
	const digest = createHash("sha256").update(label);
	for (const change of changes) digest.update(`\0${change.path}\0${change.from ?? ""}\0${change.before ?? "\x01"}\0${change.after ?? "\x01"}`);
	const token = digest.update(randomBytes(4)).digest("hex").slice(0, 12);
	const paths = [...new Set(changes.flatMap((change) => [change.path, ...(change.from ? [change.from] : [])]))];
	const preview = { token, label, changes, paths, after };
	previews.set(token, preview);
	return preview;
}

export function renderPreview(preview: Preview, cwd: string): string {
	const rows = preview.changes.flatMap((change) => {
		const path = displayPath(change.path, cwd);
		if (change.delete) return [`${path}: delete`];
		const head = change.from ? `${displayPath(change.from, cwd)} -> ${path}${change.edits ? `, ${change.edits} edit(s)` : ""}` : `${path}: ${change.edits} edit(s)`;
		const before = lines(change.before ?? "");
		const after = lines(change.after ?? "");
		const samples: string[] = [];
		for (let i = 0; i < Math.max(before.length, after.length) && samples.length < MAX_SAMPLES; i++) {
			if (before[i] !== after[i] && !change.from) samples.push(`  ${i + 1}- ${(before[i] ?? "").trim()}\n  ${i + 1}+ ${(after[i] ?? "").trim()}`);
		}
		return [head, ...samples];
	});
	return [`Preview of ${preview.label}: ${preview.changes.length} file(s). Nothing written; call again with apply: true and token "${preview.token}".`, ...rows].join("\n");
}

/** Writes through a temporary file with the mode of `modeOf`, the file itself unless it is a move; a symlink's target is written, not replaced. */
async function writeKeepingMode(link: string, content: string, modeOf = link) {
	const path = await realpath(link).catch(() => link);
	const mode = await stat(modeOf).then(
		(info) => info.mode,
		() => undefined,
	);
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.pi-lsp-${process.pid}-${randomBytes(3).toString("hex")}`;
	await writeFile(temp, content, mode === undefined ? undefined : { mode });
	await rename(temp, path);
}

/**
 * Applies a stored preview under the file locks: every file must still hold the content the
 * preview saw, writes go through a temporary file, and a failure part way puts back the earlier content.
 */
export async function applyPreview(token: string): Promise<Preview> {
	const preview = previews.get(token);
	if (!preview) throw new Error(`No preview with token ${token}; preview again.`);
	await withFileLocks(preview.paths, async () => {
		for (const change of preview.changes) {
			const expected: [string, string | undefined][] = [[change.path, change.before]];
			if (change.from) expected.push([change.from, change.fromBefore]);
			for (const [path, content] of expected) if ((await current(path)) !== content) throw new Error(`${path} changed since the preview; preview again.`);
		}
		const undo: (() => Promise<void>)[] = [];
		try {
			for (const change of preview.changes) {
				if (change.from) {
					const original = await readFile(change.from);
					await writeKeepingMode(change.path, change.after ?? "", change.from);
					await unlink(change.from);
					const previous = change.before;
					undo.push(async () => {
						await writeFile(change.from as string, original);
						if (previous === undefined) await rm(change.path, { force: true });
						else await writeFile(change.path, previous);
					});
				} else if (change.delete) {
					const original = await readFile(change.path);
					await unlink(change.path);
					undo.push(() => writeFile(change.path, original));
				} else {
					await writeKeepingMode(change.path, change.after ?? "");
					const previous = change.before;
					undo.push(async () => (previous === undefined ? rm(change.path, { force: true }) : writeFile(change.path, previous)));
				}
			}
		} catch (error) {
			for (const step of undo.reverse()) await step().catch(() => undefined);
			throw new Error(`Apply failed and was rolled back: ${(error as Error).message}`);
		}
	});
	previews.delete(token);
	for (const change of preview.changes) if (change.after !== undefined) recordWritten(change.path, change.after.replace(/^\ufeff/, ""));
	await preview.after?.().catch(() => undefined);
	return preview;
}
