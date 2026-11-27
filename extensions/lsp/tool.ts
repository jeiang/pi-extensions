import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type {
	CallHierarchyIncomingCall,
	CallHierarchyItem,
	CallHierarchyOutgoingCall,
	CodeAction,
	Command,
	Diagnostic,
	DocumentSymbol,
	Hover,
	Location,
	LocationLink,
	Position,
	SymbolInformation,
	WorkspaceEdit,
	WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import { type Static, Type } from "typebox";
import type { LspClient } from "./client.ts";
import type { Route } from "./config.ts";
import { reports, renderFinding, type Service } from "./diagnostics.ts";
import { applyPreview, type FileChange, planWorkspaceEdit, renderPreview, storePreview } from "./edits.ts";
import { instances } from "./pool.ts";
import { displayPath, type FlatSymbol, findSymbol, flattenSymbols, kindName, lines, toColumn, toServerCharacter } from "./text.ts";

const exec = promisify(execFile);
const MAX_RESULTS = 100;
const MAX_DIAGNOSTIC_FILES = 50;
const WARM_FILES = 20;
/** function, method, constructor, variable, constant: their children are locals. */
const LEAF_KINDS = new Set([12, 6, 9, 13, 14]);

export const lspParams = Type.Object({
	op: Type.Union(
		[
			Type.Literal("definition"),
			Type.Literal("type_definition"),
			Type.Literal("implementation"),
			Type.Literal("references"),
			Type.Literal("hover"),
			Type.Literal("symbols"),
			Type.Literal("workspace_symbols"),
			Type.Literal("calls"),
			Type.Literal("diagnostics"),
			Type.Literal("rename"),
			Type.Literal("rename_file"),
			Type.Literal("code_actions"),
			Type.Literal("status"),
		],
		{
			description:
				"definition, type_definition, implementation, references, hover, calls: a position. symbols: a file's outline. workspace_symbols: search by name. diagnostics: files or directories. rename, rename_file, code_actions: preview, then apply with the token. status: servers and their state.",
		},
	),
	path: Type.Optional(Type.String({ description: "File, relative to the working directory or absolute. workspace_symbols: picks the server." })),
	line: Type.Optional(Type.Number({ description: "1-based line." })),
	character: Type.Optional(Type.Number({ description: "1-based column in characters; or give symbol instead." })),
	symbol: Type.Optional(
		Type.String({
			description: "A name instead of a column: with line, its occurrence on that line (foo, or foo#2 for the second); without line, the declaration in the file (foo, Class.method, foo#2).",
		}),
	),
	query: Type.Optional(Type.String({ description: "workspace_symbols: the name to search for." })),
	paths: Type.Optional(Type.Array(Type.String(), { description: "diagnostics: files or directories; default path, else the working directory." })),
	severity: Type.Optional(Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info"), Type.Literal("hint")], { description: "diagnostics: lowest severity shown; default warning." })),
	direction: Type.Optional(Type.Union([Type.Literal("in"), Type.Literal("out")], { description: "calls: in lists callers (default), out lists callees." })),
	new_name: Type.Optional(Type.String({ description: "rename: the new name." })),
	new_path: Type.Optional(Type.String({ description: "rename_file: where the file moves; imports that name it are updated." })),
	end_line: Type.Optional(Type.Number({ description: "code_actions: last line of the range (default line)." })),
	end_character: Type.Optional(Type.Number({ description: "code_actions: column after the range's end." })),
	index: Type.Optional(Type.Number({ description: "code_actions: the number of the listed action to preview." })),
	apply: Type.Optional(Type.Boolean({ description: "rename, rename_file, code_actions: write the previewed change; needs token." })),
	token: Type.Optional(Type.String({ description: "The token a preview returned." })),
});
export type LspParams = Static<typeof lspParams>;

export const lspOutput = Type.Object({
	text: Type.String({ description: "The result as the direct tool shows it." }),
	token: Type.Optional(Type.String({ description: "A preview's token, for apply." })),
	applied: Type.Optional(Type.Boolean()),
	files: Type.Optional(Type.Array(Type.String(), { description: "Files a preview or apply changes." })),
	diagnostics: Type.Optional(Type.String({ description: "After apply: new diagnostics in the changed files." })),
});
export type LspOutput = Static<typeof lspOutput>;

type Located = { route: Route; client: LspClient; path: string; uri: string; text: string };

/** The first server for the file whose capabilities pass `supports`, synced with the file on disk. */
async function open(service: Service, path: string, supports: (client: LspClient) => unknown, what: string): Promise<Located> {
	const routes = service.routes(path);
	if (routes.length === 0) throw new Error(`No language server is configured for ${displayPath(path, service.cwd)}.`);
	const errors: string[] = [];
	for (const route of routes) {
		try {
			const client = await service.client(route);
			if (!supports(client)) {
				errors.push(`${route.server.id} has no ${what}`);
				continue;
			}
			const doc = await client.sync(path, route.languageId);
			return { route, client, path, uri: doc.uri, text: doc.text };
		} catch (error) {
			errors.push((error as Error).message.split("\n")[0] ?? "");
		}
	}
	throw new Error(`No server can answer ${what} for ${displayPath(path, service.cwd)}: ${errors.join("; ")}`);
}

async function symbolsOf(at: Located) {
	const result = await at.client.request<(DocumentSymbol | SymbolInformation)[] | null>("textDocument/documentSymbol", { textDocument: { uri: at.uri } });
	return flattenSymbols(result ?? []);
}

/** The server position the input names: line and character, line and symbol, or a symbol alone. */
async function position(at: Located, input: LspParams): Promise<Position> {
	if (input.line === undefined) {
		if (!input.symbol) throw new Error("Give line with character or symbol, or a symbol alone.");
		if (!at.client.capabilities.documentSymbolProvider) throw new Error(`${at.route.server.id} cannot list symbols; give line and character.`);
		return findSymbol(await symbolsOf(at), input.symbol).selection.start;
	}
	const line = Math.floor(input.line) - 1;
	const text = lines(at.text)[line];
	if (text === undefined) throw new Error(`Line ${input.line} is past the end of ${displayPath(at.path, "")} (${lines(at.text).length} lines).`);
	let column: number;
	if (input.symbol) {
		const [, name = input.symbol, nth = "1"] = /^(.*?)(?:#(\d+))?$/.exec(input.symbol) ?? [];
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const found = [...text.matchAll(new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, "gu"))][Number(nth) - 1];
		if (found?.index === undefined) throw new Error(`${name} does not occur ${nth === "1" ? "" : `${nth} times `}on line ${input.line}: ${text.trim()}`);
		column = [...text.slice(0, found.index)].length;
	} else column = Math.max(0, Math.floor(input.character ?? 1) - 1);
	return { line, character: toServerCharacter(text, column, at.client.encoding) };
}

/** `path:line:col  source line` for each location, reading each file once. */
async function renderLocations(locations: (Location | LocationLink)[], client: LspClient, cwd: string, suffix?: (i: number) => string): Promise<string> {
	const texts = new Map<string, string[] | undefined>();
	const rows: string[] = [];
	for (const [i, location] of locations.slice(0, MAX_RESULTS).entries()) {
		const uri = "targetUri" in location ? location.targetUri : location.uri;
		const range = "targetUri" in location ? location.targetSelectionRange : location.range;
		if (!uri.startsWith("file:")) {
			rows.push(`${uri}:${range.start.line + 1}`);
			continue;
		}
		const path = fileURLToPath(uri);
		if (!texts.has(path)) texts.set(path, await readFile(path, "utf8").then(lines, () => undefined));
		const line = texts.get(path)?.[range.start.line] ?? "";
		const column = toColumn(line, range.start.character, client.encoding) + 1;
		rows.push(`${displayPath(path, cwd)}:${range.start.line + 1}:${column}  ${line.trim()}${suffix ? suffix(i) : ""}`);
	}
	if (locations.length > MAX_RESULTS) rows.push(`… ${locations.length - MAX_RESULTS} more`);
	return rows.join("\n");
}

function hoverText(hover: Hover | null): string {
	if (!hover) return "No hover information.";
	const part = (value: unknown): string =>
		typeof value === "string" ? value : value && typeof value === "object" && "value" in value ? String((value as { value: unknown }).value) : "";
	const contents = Array.isArray(hover.contents) ? hover.contents.map(part).join("\n\n") : part(hover.contents);
	return contents.trim() || "No hover information.";
}

/**
 * Opens one file in each project directory under the root, once per server instance, so a server
 * that loads projects lazily (a monorepo's tsconfigs) knows the whole workspace before a search.
 */
function warmUp(at: Located): Promise<void> {
	const instance = [...instances.values()].find((i) => i.client === at.client);
	if (!instance) return Promise.resolve();
	instance.warmed ??= (async () => {
		const { server, root, languageId } = at.route;
		const markers = server.rootMarkers;
		if (markers.length === 0) return;
		const files = await exec("git", ["ls-files", "-co", "--exclude-standard"], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).then(
			(r) => r.stdout.split("\n").filter(Boolean),
			() => [] as string[],
		);
		const projects = new Set(files.filter((f) => markers.some((m) => f === m || f.endsWith(`/${m}`))).map((f) => f.slice(0, Math.max(0, f.lastIndexOf("/")))));
		const language = server.languages.find((l) => l.languageId === languageId);
		const picks: string[] = [];
		for (const dir of projects) {
			const file = files.find((f) => (dir ? f.startsWith(`${dir}/`) : true) && language?.extensions.some((ext) => f.endsWith(ext)));
			if (file) picks.push(join(root, file));
			if (picks.length >= WARM_FILES) break;
		}
		await Promise.all(picks.map((file) => at.client.sync(file, languageId).catch(() => undefined)));
	})();
	return instance.warmed;
}

/** Source files under a directory that some server covers. */
async function filesUnder(service: Service, dir: string): Promise<string[]> {
	const listed = await exec("git", ["ls-files", "-co", "--exclude-standard"], { cwd: dir, maxBuffer: 64 * 1024 * 1024 }).then(
		(r) => r.stdout.split("\n").filter(Boolean).map((f) => join(dir, f)),
		async () =>
			(await readdir(dir, { recursive: true, withFileTypes: true }))
				.filter((e) => e.isFile() && !relative(dir, e.parentPath).split("/").includes(".git"))
				.map((e) => join(e.parentPath, e.name)),
	);
	return listed.filter((file) => service.routes(file).length > 0);
}

const SEVERITIES = { error: 1, warning: 2, info: 3, hint: 4 } as const;

async function diagnosticsOp(service: Service, targets: string[], severity: number): Promise<string> {
	const files: string[] = [];
	for (const target of targets) {
		const info = await stat(target).catch(() => undefined);
		if (!info) throw new Error(`${displayPath(target, service.cwd)} does not exist.`);
		if (info.isDirectory()) files.push(...(await filesUnder(service, target)));
		else files.push(target);
	}
	if (files.length === 0) return "No files here that a configured language server covers.";
	const checked = [...new Set(files)].slice(0, MAX_DIAGNOSTIC_FILES);
	const byFile = await reports(service, checked);
	const rows: string[] = [];
	const notes: string[] = [];
	let clean = 0;
	for (const report of byFile.values()) {
		const shown = report.findings.filter((f) => (f.diagnostic.severity ?? 1) <= severity);
		for (const finding of shown.sort((a, b) => a.diagnostic.range.start.line - b.diagnostic.range.start.line)) rows.push(renderFinding(finding, report, service.cwd));
		for (const outcome of report.outcomes)
			if (outcome.status !== "fresh") notes.push(`${displayPath(report.path, service.cwd)}: ${outcome.server} ${outcome.status === "timeout" ? "timed out" : `unavailable (${outcome.detail})`}`);
		if (shown.length === 0 && report.outcomes.every((o) => o.status === "fresh")) clean++;
	}
	const more = files.length > checked.length ? ` Checked the first ${checked.length} of ${files.length} files; name fewer paths for the rest.` : "";
	return [`${rows.length} finding(s) in ${checked.length} file(s); ${clean} clean.${more}`, ...rows, ...notes].join("\n");
}

function statusText(service: Service): string {
	const rows = [...instances.values()].map((i) => {
		const client = i.client;
		const state = client?.alive ? "running" : i.starting ? "starting" : i.lastError ? `failed: ${i.lastError.split("\n")[0]}` : "stopped";
		const caps = client
			? Object.keys(client.capabilities)
					.filter((key) => key.endsWith("Provider") && (client.capabilities as Record<string, unknown>)[key])
					.map((key) => key.replace(/Provider$/, ""))
					.join(", ")
			: "";
		return [`${i.def.id} at ${i.root}: ${state}${client?.serverName ? ` (${client.serverName}, ${client.encoding})` : ""}`, ...(client ? [`  open documents: ${client.openPaths().length}`, `  capabilities: ${caps}`] : [])].join("\n");
	});
	const configured = [...service.settings.servers.values()].map((s) => `${s.id} (${s.languages.flatMap((l) => [...l.extensions, ...l.fileNames]).join(" ")})`);
	return [
		rows.length ? rows.join("\n") : "No server running; one starts on the first file of its language.",
		`Configured: ${configured.join(", ") || "none (settings.json lsp.servers)"}`,
		...(service.settings.warnings.length ? [`Settings warnings:\n- ${service.settings.warnings.join("\n- ")}`] : []),
	].join("\n");
}

async function preview(service: Service, label: string, changes: FileChange[], after?: () => Promise<void>): Promise<LspOutput> {
	if (changes.length === 0) return { text: `${label}: nothing to change.` };
	const stored = storePreview(label, changes, after);
	return { text: renderPreview(stored, service.cwd), token: stored.token, applied: false, files: stored.paths.map((p) => displayPath(p, service.cwd)) };
}

async function codeActions(service: Service, at: Located, input: LspParams): Promise<LspOutput> {
	const start = await position(at, input);
	const endLine = input.end_line === undefined ? start.line : Math.floor(input.end_line) - 1;
	const endText = lines(at.text)[endLine] ?? "";
	const end = { line: endLine, character: input.end_character === undefined ? (input.end_line === undefined ? start.character : endText.length) : toServerCharacter(endText, Math.floor(input.end_character) - 1, at.client.encoding) };
	const range = { start, end };
	const pushed = await at.client.diagnostics(at.path, at.route.languageId).catch(() => ({ items: [] as Diagnostic[] }));
	const overlapping = pushed.items.filter((d) => d.range.start.line <= end.line && d.range.end.line >= start.line);
	const actions =
		(await at.client.request<(CodeAction | Command)[] | null>("textDocument/codeAction", { textDocument: { uri: at.uri }, range, context: { diagnostics: overlapping } })) ?? [];
	if (input.index === undefined)
		return {
			text: actions.length
				? actions.map((a, i) => `${i + 1}. ${a.title}${"kind" in a && a.kind ? ` (${a.kind})` : ""}${"isPreferred" in a && a.isPreferred ? " preferred" : ""}${"edit" in a || "data" in a ? "" : " [command only]"}`).join("\n") + "\nPreview one with index."
				: "No code actions here.",
		};
	let action = actions[Math.floor(input.index) - 1];
	if (!action) throw new Error(`No action ${input.index}; there are ${actions.length}.`);
	if (!("edit" in action && action.edit) && "data" in action && at.client.capabilities.codeActionProvider && typeof at.client.capabilities.codeActionProvider === "object" && at.client.capabilities.codeActionProvider.resolveProvider)
		action = await at.client.request<CodeAction>("codeAction/resolve", action);
	const edit = "edit" in action ? action.edit : undefined;
	if (!edit) throw new Error(`"${action.title}" runs a server command and carries no edit; it cannot be previewed.`);
	return preview(service, `code action "${action.title}"`, await planWorkspaceEdit(edit, at.client.encoding));
}

/** 1-based inclusive lines of a declaration found by name, for read({ path, symbol }). */
export async function symbolLines(service: Service, path: string, symbol: string): Promise<{ start: number; end: number }> {
	const at = await open(service, path, (client) => client.capabilities.documentSymbolProvider, "document symbols");
	const found = findSymbol(await symbolsOf(at), symbol);
	return { start: found.range.start.line + 1, end: found.range.end.line + 1 };
}

export async function runLsp(service: Service, input: LspParams, resolvePath: (path: string) => string): Promise<LspOutput> {
	const path = input.path ? resolvePath(input.path) : undefined;
	const need = () => {
		if (!path) throw new Error(`${input.op} needs path.`);
		return path;
	};
	if (input.apply) {
		if (!input.token) throw new Error("apply needs the token of a preview.");
		const done = await applyPreview(input.token);
		return { text: `Applied ${done.label}: ${done.changes.length} file(s) changed.`, applied: true, files: done.paths.map((p) => displayPath(p, service.cwd)) };
	}
	const label = input.op.replace("_", " ");
	const caps = (key: string) => (client: LspClient) => (client.capabilities as Record<string, unknown>)[key];
	switch (input.op) {
		case "status":
			return { text: statusText(service) };
		case "definition":
		case "type_definition":
		case "implementation":
		case "references": {
			const provider = { definition: "definitionProvider", type_definition: "typeDefinitionProvider", implementation: "implementationProvider", references: "referencesProvider" }[input.op];
			const at = await open(service, need(), caps(provider), label);
			const pos = await position(at, input);
			if (input.op === "references" || input.op === "implementation") await warmUp(at);
			const method = { definition: "textDocument/definition", type_definition: "textDocument/typeDefinition", implementation: "textDocument/implementation", references: "textDocument/references" }[input.op];
			const params = { textDocument: { uri: at.uri }, position: pos, ...(input.op === "references" ? { context: { includeDeclaration: true } } : {}) };
			const result = await at.client.request<Location | Location[] | LocationLink[] | null>(method, params);
			const list = result ? (Array.isArray(result) ? result : [result]) : [];
			return { text: list.length ? await renderLocations(list, at.client, service.cwd) : `No ${label} found.` };
		}
		case "hover": {
			const at = await open(service, need(), caps("hoverProvider"), "hover");
			return { text: hoverText(await at.client.request<Hover | null>("textDocument/hover", { textDocument: { uri: at.uri }, position: await position(at, input) })) };
		}
		case "symbols": {
			const at = await open(service, need(), caps("documentSymbolProvider"), "document symbols");
			// Locals inside functions and the fields of object literals are noise in an outline.
			const symbols: FlatSymbol[] = [];
			let hideBelow = Number.POSITIVE_INFINITY;
			for (const s of await symbolsOf(at)) {
				if (s.depth > hideBelow) continue;
				hideBelow = LEAF_KINDS.has(s.kind) ? s.depth : Number.POSITIVE_INFINITY;
				symbols.push(s);
			}
			return {
				text: symbols.length
					? symbols.map((s) => `${"  ".repeat(s.depth)}${s.range.start.line + 1}-${s.range.end.line + 1} ${kindName(s.kind)} ${s.name}`).join("\n")
					: "No symbols.",
			};
		}
		case "workspace_symbols": {
			if (input.query === undefined) throw new Error("workspace_symbols needs query.");
			let at: Located | undefined;
			if (path) at = await open(service, path, caps("workspaceSymbolProvider"), "workspace symbols");
			const clients = at ? [at.client] : [...instances.values()].flatMap((i) => (i.client?.alive && i.client.capabilities.workspaceSymbolProvider ? [i.client] : []));
			if (clients.length === 0) throw new Error("No running server can search the workspace; pass path to a file of the language.");
			if (at) await warmUp(at);
			const rows: string[] = [];
			for (const client of clients) {
				const found = (await client.request<(SymbolInformation | WorkspaceSymbol)[] | null>("workspace/symbol", { query: input.query })) ?? [];
				const locations = found.map((s) => ("range" in s.location ? s.location : { uri: s.location.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }));
				if (found.length) rows.push(await renderLocations(locations, client, service.cwd, (i) => `  [${kindName(found[i]?.kind ?? 0)} ${found[i]?.name ?? ""}]`));
			}
			return { text: rows.join("\n") || `No symbol matches ${input.query}.` };
		}
		case "calls": {
			const at = await open(service, need(), caps("callHierarchyProvider"), "call hierarchy");
			const items = (await at.client.request<CallHierarchyItem[] | null>("textDocument/prepareCallHierarchy", { textDocument: { uri: at.uri }, position: await position(at, input) })) ?? [];
			if (items.length === 0) return { text: "No callable symbol at that position." };
			const outgoing = input.direction === "out";
			if (!outgoing) await warmUp(at);
			const rows: string[] = [];
			for (const item of items) {
				const calls = outgoing
					? ((await at.client.request<CallHierarchyOutgoingCall[] | null>("callHierarchy/outgoingCalls", { item })) ?? []).map((c) => c.to)
					: ((await at.client.request<CallHierarchyIncomingCall[] | null>("callHierarchy/incomingCalls", { item })) ?? []).map((c) => c.from);
				const locations = calls.map((c) => ({ uri: c.uri, range: c.selectionRange }));
				rows.push(`${outgoing ? "Callees of" : "Callers of"} ${item.name}:`, (await renderLocations(locations, at.client, service.cwd, (i) => `  [${kindName(calls[i]?.kind ?? 0)} ${calls[i]?.name ?? ""}]`)) || "  none");
			}
			return { text: rows.join("\n") };
		}
		case "diagnostics": {
			const targets = (input.paths?.length ? input.paths.map(resolvePath) : [path ?? service.cwd]).filter(Boolean);
			const severity = input.severity ? SEVERITIES[input.severity] : service.settings.includeHintDiagnostics ? 4 : 2;
			return { text: await diagnosticsOp(service, targets, severity) };
		}
		case "rename": {
			if (!input.new_name) throw new Error("rename needs new_name.");
			const at = await open(service, need(), caps("renameProvider"), "rename");
			const pos = await position(at, input);
			await warmUp(at);
			const edit = await at.client.request<WorkspaceEdit | null>("textDocument/rename", { textDocument: { uri: at.uri }, position: pos, newName: input.new_name });
			if (!edit) throw new Error("The server cannot rename the symbol at that position.");
			return preview(service, `rename to ${input.new_name}`, await planWorkspaceEdit(edit, at.client.encoding));
		}
		case "rename_file": {
			if (!input.new_path) throw new Error("rename_file needs new_path.");
			const from = need();
			const to = resolvePath(input.new_path);
			const files = [{ oldUri: pathToFileURL(from).href, newUri: pathToFileURL(to).href }];
			let edit: WorkspaceEdit = {};
			let client: LspClient | undefined;
			const willRename = (c: LspClient) => c.capabilities.workspace?.fileOperations?.willRename;
			try {
				const at = await open(service, from, willRename, "file rename");
				client = at.client;
				await warmUp(at);
				edit = (await at.client.request<WorkspaceEdit | null>("workspace/willRenameFiles", { files })) ?? {};
			} catch (error) {
				if (service.routes(from).length > 0 && !/has no file rename/.test((error as Error).message)) throw error;
			}
			const changes = await planWorkspaceEdit({ ...edit, documentChanges: [...(edit.documentChanges ?? []), { kind: "rename", oldUri: files[0]!.oldUri, newUri: files[0]!.newUri }] }, client?.encoding ?? "utf-16");
			const notify = client;
			return preview(service, `move ${displayPath(from, service.cwd)} to ${displayPath(to, service.cwd)}`, changes, async () => {
				// The server must not keep the old path open beside the moved file.
				for (const route of service.routes(from)) await (await service.client(route).catch(() => undefined))?.close(from);
				if (notify?.capabilities.workspace?.fileOperations?.didRename) await notify.notify("workspace/didRenameFiles", { files });
			});
		}
		case "code_actions": {
			const at = await open(service, need(), caps("codeActionProvider"), "code actions");
			return codeActions(service, at, input);
		}
	}
	throw new Error(`Unknown op ${String(input.op)}.`);
}

