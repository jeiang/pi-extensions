import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import type { Diagnostic, DocumentSymbol, Location, SymbolInformation } from "vscode-languageserver-protocol";
import type { Encoding, LspClient } from "./client.ts";
import type { LspSettings, Route } from "./config.ts";
import { clientFor } from "./pool.ts";
import { diagnosticLine, displayPath, flattenSymbols, lines } from "./text.ts";

const exec = promisify(execFile);
const MAX_DEPENDENTS = 20;
const MAX_TOUCHED_SYMBOLS = 5;

/** A finding from a server or a rule scan, matched across an edit by its text, not its position. */
export interface Finding {
	source: string;
	diagnostic: Diagnostic;
	encoding: Encoding;
}

export interface FileReport {
	path: string;
	/** One outcome per server that covers the file: clean, a count, timeout, or why it is unavailable. */
	outcomes: { server: string; status: "fresh" | "timeout" | "unavailable"; detail?: string }[];
	findings: Finding[];
	text?: string;
}

export const matchKey = (finding: Finding, text: string | undefined) => {
	const d = finding.diagnostic;
	const line = text === undefined ? "" : (lines(text)[d.range.start.line] ?? "").trim();
	const message = typeof d.message === "string" ? d.message : d.message.value;
	return [finding.source, d.severity ?? 1, String(d.code ?? ""), message, line].join("\0");
};

/** The findings in `after` that `before` lacks, counted as multisets; also how many matched. */
export function newFindings(before: FileReport | undefined, after: FileReport): { added: Finding[]; unchanged: number } {
	const counts = new Map<string, number>();
	for (const finding of before?.findings ?? []) {
		const key = matchKey(finding, before?.text);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const added: Finding[] = [];
	let unchanged = 0;
	for (const finding of after.findings) {
		const key = matchKey(finding, after.text);
		const left = counts.get(key) ?? 0;
		if (left > 0) {
			counts.set(key, left - 1);
			unchanged++;
		} else added.push(finding);
	}
	return { added, unchanged };
}

export interface Service {
	settings: LspSettings;
	cwd: string;
	routes(path: string): Route[];
	client(route: Route): Promise<LspClient>;
}

export function makeService(settings: LspSettings, cwd: string, enabled: (id: string) => boolean, routes: (path: string) => Route[]): Service {
	return {
		settings,
		cwd,
		routes: (path) => routes(path).filter((route) => enabled(route.server.id)),
		client: (route) => clientFor(route.server, route.root, settings.timeouts, settings.idleMinutes),
	};
}

/** Errors and warnings; info and hints only when the settings ask for them. */
export const visible = (settings: LspSettings, d: Diagnostic) => (d.severity ?? 1) <= 2 || settings.includeHintDiagnostics;

/** Diagnostics of every server for one file as it is on disk, with each server's outcome. */
export async function fileReport(service: Service, path: string, signal?: AbortSignal): Promise<FileReport> {
	const report: FileReport = { path, outcomes: [], findings: [] };
	report.text = await readFile(path, "utf8").catch(() => undefined);
	await Promise.all(
		service.routes(path).map(async (route) => {
			const server = route.server.id;
			try {
				const client = await service.client(route);
				const result = await client.diagnostics(path, route.languageId, signal);
				report.outcomes.push({ server, status: result.status });
				for (const diagnostic of result.items) report.findings.push({ source: server, diagnostic, encoding: client.encoding });
			} catch (error) {
				report.outcomes.push({ server, status: "unavailable", detail: (error as Error).message.split("\n")[0] });
			}
		}),
	);
	return report;
}

const RULE_LANGUAGES: Record<string, string[]> = {
	nix: [".nix"],
	typescript: [".ts", ".mts", ".cts"],
	tsx: [".tsx"],
	javascript: [".js", ".mjs", ".cjs", ".jsx"],
	python: [".py"],
	rust: [".rs"],
	go: [".go"],
	bash: [".sh", ".bash"],
	yaml: [".yaml", ".yml"],
};
const ruleLanguages = new Map<string, Promise<string[] | undefined>>();
/** The extensions a rule file's languages cover; undefined when one is unknown, so every file is scanned. */
function extensionsOf(rule: string): Promise<string[] | undefined> {
	let pending = ruleLanguages.get(rule);
	if (!pending) {
		pending = readFile(rule, "utf8").then(
			(text) => {
				const names = [...text.matchAll(/^language:\s*["']?(\w+)/gim)].map((m) => (m[1] ?? "").toLowerCase());
				return names.every((name) => RULE_LANGUAGES[name]) ? names.flatMap((name) => RULE_LANGUAGES[name] ?? []) : undefined;
			},
			() => [],
		);
		ruleLanguages.set(rule, pending);
	}
	return pending;
}

interface AstGrepMatch {
	file: string;
	range: { start: { line: number; column: number }; end: { line: number; column: number } };
	message?: string;
	severity?: string;
	ruleId?: string;
}

/** ast-grep findings for the files, keyed by path, as diagnostics. */
export async function ruleFindings(settings: LspSettings, paths: string[], cwd: string): Promise<Map<string, Finding[]>> {
	const out = new Map<string, Finding[]>();
	const config = settings.astGrep;
	if (!config) return out;
	for (const rule of config.rules) {
		const extensions = await extensionsOf(rule);
		const files = paths.filter((path) => !extensions || extensions.includes(extname(path)));
		if (files.length === 0) continue;
		const { stdout } = await exec(config.command, ["scan", "--rule", rule, "--json=compact", ...files], { cwd, timeout: 10_000, maxBuffer: 16 * 1024 * 1024 }).catch(
			(error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }),
		);
		let matches: AstGrepMatch[] = [];
		try {
			matches = JSON.parse(stdout || "[]") as AstGrepMatch[];
		} catch {
			continue;
		}
		for (const match of matches) {
			const severity = match.severity === "error" ? 1 : match.severity === "warning" ? 2 : match.severity === "info" ? 3 : 4;
			const file = files.find((path) => path === match.file || path.endsWith(`/${match.file}`)) ?? match.file;
			const diagnostic: Diagnostic = {
				range: { start: { line: match.range.start.line, character: match.range.start.column }, end: { line: match.range.end.line, character: match.range.end.column } },
				severity: severity as Diagnostic["severity"],
				source: "ast-grep",
				code: match.ruleId,
				message: match.message ?? match.ruleId ?? "rule match",
			};
			out.set(file, [...(out.get(file) ?? []), { source: "ast-grep", diagnostic, encoding: "utf-32" }]);
		}
	}
	return out;
}

/** Reports for the files from every server and the rule scan. */
export async function reports(service: Service, paths: string[], signal?: AbortSignal): Promise<Map<string, FileReport>> {
	const [byFile, rules] = await Promise.all([
		Promise.all(paths.map((path) => fileReport(service, path, signal))),
		ruleFindings(service.settings, paths, service.cwd).catch(() => new Map<string, Finding[]>()),
	]);
	const out = new Map<string, FileReport>();
	for (const report of byFile) {
		const found = rules.get(report.path);
		if (found) {
			report.findings.push(...found);
			report.outcomes.push({ server: "ast-grep", status: "fresh" });
		}
		out.set(report.path, report);
	}
	return out;
}

export const renderFinding = (finding: Finding, report: FileReport, cwd: string) =>
	diagnosticLine(displayPath(report.path, cwd), report.text, finding.diagnostic, finding.encoding);

/** Lines of the changed region of `after` against `before`, 0-based inclusive; undefined when nothing changed. */
function changedLines(before: string, after: string): [number, number] | undefined {
	if (before === after) return undefined;
	const a = lines(before);
	const b = lines(after);
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length - 1;
	let endB = b.length - 1;
	while (endA >= start && endB >= start && a[endA] === b[endB]) {
		endA--;
		endB--;
	}
	return [start, Math.max(start, endB)];
}

/**
 * New errors in files that reference the declarations an edit touched: the server is shown the
 * old text for a baseline of those files, then the new text again.
 */
export async function dependentErrors(service: Service, path: string, before: string, after: string, deadline: number): Promise<{ lines: string[]; scanned: number }> {
	const changed = changedLines(before, after);
	const out: string[] = [];
	let scanned = 0;
	if (!changed) return { lines: out, scanned };
	for (const route of service.routes(path)) {
		if (Date.now() > deadline) break;
		const client = await service.client(route).catch(() => undefined);
		if (!client?.capabilities.referencesProvider || !client.capabilities.documentSymbolProvider) continue;
		const uri = pathToFileURL(path).href;
		const symbols = flattenSymbols(
			(await client.request<(DocumentSymbol | SymbolInformation)[] | null>("textDocument/documentSymbol", { textDocument: { uri } }).catch(() => null)) ?? [],
		);
		const touched = symbols
			.filter((s) => s.range.start.line <= changed[1] && s.range.end.line >= changed[0])
			.sort((a, b) => b.depth - a.depth)
			.slice(0, MAX_TOUCHED_SYMBOLS);
		const files = new Set<string>();
		for (const symbol of touched) {
			if (Date.now() > deadline) break;
			const refs = await client
				.request<Location[] | null>("textDocument/references", { textDocument: { uri }, position: symbol.selection.start, context: { includeDeclaration: false } })
				.catch(() => null);
			for (const ref of refs ?? []) {
				const file = new URL(ref.uri).pathname;
				if (ref.uri.startsWith("file:") && decodeURIComponent(file) !== path) files.add(decodeURIComponent(file));
			}
		}
		const dependents = [...files].filter((file) => service.routes(file).some((r) => r.server.id === route.server.id)).slice(0, MAX_DEPENDENTS);
		if (dependents.length === 0 || Date.now() > deadline) continue;
		const errorsOf = async () => {
			const map = new Map<string, FileReport>();
			const mark = client.revisionNow();
			for (const file of dependents) {
				const result = await client.diagnostics(file, service.routes(file).find((r) => r.server.id === route.server.id)?.languageId ?? route.languageId, undefined, mark).catch(() => undefined);
				const text = await readFile(file, "utf8").catch(() => undefined);
				map.set(file, {
					path: file,
					text,
					outcomes: [],
					findings: (result?.items ?? []).filter((d) => (d.severity ?? 1) === 1).map((diagnostic) => ({ source: route.server.id, diagnostic, encoding: client.encoding })),
				});
			}
			return map;
		};
		await client.sync(path, route.languageId, before);
		const baseline = await errorsOf();
		await client.sync(path, route.languageId, after);
		const now = await errorsOf();
		scanned += dependents.length;
		for (const [file, report] of now) for (const finding of newFindings(baseline.get(file), report).added) out.push(renderFinding(finding, report, service.cwd));
	}
	return { lines: out, scanned };
}

