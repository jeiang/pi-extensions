import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, matchesGlob, relative, resolve } from "node:path";

export interface Language {
	languageId: string;
	extensions: string[];
	fileNames: string[];
}

export interface ServerDef {
	id: string;
	command: string;
	args: string[];
	/** The full environment the server starts with: pi's, with the configured overrides. */
	env: Record<string, string>;
	languages: Language[];
	rootMarkers: string[];
	workspaceRootMarkers: string[];
	requireRootMarker: boolean;
	initializationOptions?: unknown;
	settings?: unknown;
	maxConcurrentDiagnostics: number;
}

export interface Timeouts {
	diagnosticsMs: number;
	initializeMs: number;
	requestMs: number;
	shutdownMs: number;
	workspaceRequestMs: number;
}

export interface LspSettings {
	servers: Map<string, ServerDef>;
	timeouts: Timeouts;
	/** Servers switched on or off in settings; a session's /lsp choice overrides these. */
	enablement: Map<string, boolean>;
	includeHintDiagnostics: boolean;
	idleMinutes: number;
	/** ast-grep rule files scanned on edited files, reported with the diagnostics. */
	astGrep?: { command: string; rules: string[] };
	warnings: string[];
}

const DEFAULT_TIMEOUTS: Timeouts = { diagnosticsMs: 3000, initializeMs: 45000, requestMs: 3000, shutdownMs: 5000, workspaceRequestMs: 15000 };
const SERVER_FIELDS = new Set([
	"args",
	"command",
	"environment",
	"initializationOptions",
	"languages",
	"maxConcurrentDiagnostics",
	"requireRootMarker",
	"rootMarkers",
	"settings",
	"workspaceRootMarkers",
]);
const TOP_FIELDS = new Set(["servers", "timeouts", "enablement", "includeHintDiagnostics", "idleMinutes", "astGrep"]);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
const positive = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;

/** Why a server definition is unusable, or undefined when it is valid. */
function invalid(raw: Json): string | undefined {
	const unknown = Object.keys(raw).find((key) => !SERVER_FIELDS.has(key));
	if (unknown) return `unknown field ${unknown}`;
	if (typeof raw.command !== "string" || !raw.command) return "command is required";
	if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((arg) => typeof arg === "string"))) return "args must be strings";
	if (raw.environment !== undefined && !(isObject(raw.environment) && Object.values(raw.environment).every((v) => v === null || typeof v === "string")))
		return "environment values must be strings or null";
	if (!Array.isArray(raw.languages) || raw.languages.length === 0) return "languages is required";
	for (const language of raw.languages) {
		if (!isObject(language) || typeof language.languageId !== "string" || !language.languageId) return "each language needs a languageId";
		if (language.extensions === undefined && language.fileNames === undefined) return "each language needs extensions or fileNames";
		if ((language.extensions !== undefined && !strings(language.extensions)) || (language.fileNames !== undefined && !strings(language.fileNames)))
			return "language extensions and fileNames must be strings";
	}
	for (const key of ["rootMarkers", "workspaceRootMarkers"]) if (raw[key] !== undefined && !strings(raw[key])) return `${key} must be strings`;
	if (raw.requireRootMarker !== undefined && typeof raw.requireRootMarker !== "boolean") return "requireRootMarker must be a boolean";
	if (raw.requireRootMarker === true && !(raw.rootMarkers as string[] | undefined)?.length) return "requireRootMarker needs rootMarkers";
	return undefined;
}

function serverDef(id: string, raw: Json, warnings: string[], scope: string): ServerDef {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	for (const [key, value] of Object.entries((raw.environment as Record<string, string | null> | undefined) ?? {})) {
		if (value === null) delete env[key];
		else env[key] = value;
	}
	let limit = 2;
	if (raw.maxConcurrentDiagnostics !== undefined) {
		if (positive(raw.maxConcurrentDiagnostics)) limit = raw.maxConcurrentDiagnostics;
		else warnings.push(`${scope} lsp.servers.${id}.maxConcurrentDiagnostics: expected a positive integer`);
	}
	return {
		id,
		command: raw.command as string,
		args: (raw.args as string[] | undefined) ?? [],
		env,
		languages: (raw.languages as Json[]).map((language) => ({
			languageId: language.languageId as string,
			extensions: (language.extensions as string[] | undefined) ?? [],
			fileNames: (language.fileNames as string[] | undefined) ?? [],
		})),
		rootMarkers: (raw.rootMarkers as string[] | undefined) ?? [],
		workspaceRootMarkers: (raw.workspaceRootMarkers as string[] | undefined) ?? [],
		requireRootMarker: raw.requireRootMarker === true,
		initializationOptions: raw.initializationOptions,
		settings: raw.settings,
		maxConcurrentDiagnostics: limit,
	};
}

/**
 * Merges the `lsp` blocks of the global and project settings (the project's wins per server, and a
 * null server removes a global one). An invalid entry is dropped with a warning; the rest still work.
 */
export function parseSettings(layers: { scope: string; lsp: unknown }[]): LspSettings {
	const result: LspSettings = {
		servers: new Map(),
		timeouts: { ...DEFAULT_TIMEOUTS },
		enablement: new Map(),
		includeHintDiagnostics: false,
		idleMinutes: 10,
		warnings: [],
	};
	const warn = (message: string) => result.warnings.push(message);
	for (const { scope, lsp } of layers) {
		if (lsp === undefined) continue;
		if (!isObject(lsp)) {
			warn(`${scope} lsp: expected an object`);
			continue;
		}
		for (const key of Object.keys(lsp)) if (!TOP_FIELDS.has(key)) warn(`${scope} lsp.${key}: unknown field`);
		if (lsp.servers !== undefined && !isObject(lsp.servers)) warn(`${scope} lsp.servers: expected an object`);
		for (const [id, raw] of Object.entries(isObject(lsp.servers) ? lsp.servers : {})) {
			result.servers.delete(id);
			if (raw === null) continue;
			const reason = isObject(raw) ? invalid(raw) : "expected an object";
			if (reason) warn(`${scope} lsp.servers.${id}: ${reason}`);
			else result.servers.set(id, serverDef(id, raw as Json, result.warnings, scope));
		}
		for (const [name, value] of Object.entries(isObject(lsp.timeouts) ? lsp.timeouts : {})) {
			if (!(name in DEFAULT_TIMEOUTS)) warn(`${scope} lsp.timeouts.${name}: unknown field`);
			else if (!positive(value)) warn(`${scope} lsp.timeouts.${name}: expected a positive integer`);
			else result.timeouts[name as keyof Timeouts] = value;
		}
		for (const [id, value] of Object.entries(isObject(lsp.enablement) ? lsp.enablement : {})) {
			if (typeof value === "boolean") result.enablement.set(id, value);
			else warn(`${scope} lsp.enablement.${id}: expected a boolean`);
		}
		if (lsp.includeHintDiagnostics !== undefined) {
			if (typeof lsp.includeHintDiagnostics === "boolean") result.includeHintDiagnostics = lsp.includeHintDiagnostics;
			else warn(`${scope} lsp.includeHintDiagnostics: expected a boolean`);
		}
		if (lsp.idleMinutes !== undefined) {
			if (positive(lsp.idleMinutes)) result.idleMinutes = lsp.idleMinutes;
			else warn(`${scope} lsp.idleMinutes: expected a positive integer`);
		}
		if (lsp.astGrep !== undefined) {
			const raw = lsp.astGrep;
			if (isObject(raw) && strings(raw.rules) && (raw.command === undefined || typeof raw.command === "string"))
				result.astGrep = { command: (raw.command as string | undefined) ?? "ast-grep", rules: raw.rules };
			else warn(`${scope} lsp.astGrep: expected { rules: string[], command?: string }`);
		}
	}
	result.timeouts.workspaceRequestMs = Math.max(result.timeouts.workspaceRequestMs, result.timeouts.requestMs);
	return result;
}

export interface Route {
	server: ServerDef;
	languageId: string;
	root: string;
}

const within = (ancestor: string, path: string) => {
	const rel = relative(ancestor, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

function entries(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

/**
 * The servers for a file and the root each runs in: the nearest ancestor with a workspace root
 * marker (never the home directory or above unless `cwd` is), else the nearest with a root marker,
 * else `cwd`. A server that requires a root marker and finds none is skipped.
 */
export function routesFor(servers: Iterable<ServerDef>, file: string, cwd: string, home = homedir()): Route[] {
	const name = basename(file);
	const ancestors: string[] = [];
	for (let dir = dirname(resolve(file)); ; dir = dirname(dir)) {
		ancestors.push(dir);
		if (dirname(dir) === dir) break;
	}
	const listing = new Map<string, string[]>();
	const list = (dir: string) => listing.get(dir) ?? (listing.set(dir, entries(dir)), listing.get(dir) ?? []);
	const holds = (dir: string, markers: string[]) => list(dir).some((entry) => markers.some((marker) => matchesGlob(entry, marker)));
	const routes: Route[] = [];
	for (const server of servers) {
		const language = server.languages.find((l) => l.fileNames.includes(name) || l.extensions.includes(extname(name)));
		if (!language) continue;
		const markerRoot = server.rootMarkers.length ? ancestors.find((dir) => holds(dir, server.rootMarkers)) : undefined;
		if (!markerRoot && server.requireRootMarker) continue;
		const workspaceRoot = server.workspaceRootMarkers.length
			? ancestors.find((dir) => !(within(dir, home) && !within(cwd, dir)) && holds(dir, server.workspaceRootMarkers))
			: undefined;
		routes.push({ server, languageId: language.languageId, root: workspaceRoot ?? markerRoot ?? resolve(cwd) });
	}
	return routes;
}
