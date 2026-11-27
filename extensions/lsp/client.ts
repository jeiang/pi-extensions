import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	CancellationTokenSource,
	createProtocolConnection,
	type Diagnostic,
	type DocumentDiagnosticReport,
	type InitializeResult,
	type ProtocolConnection,
	type PublishDiagnosticsParams,
	type Registration,
	type ServerCapabilities,
	StreamMessageReader,
	StreamMessageWriter,
} from "vscode-languageserver-protocol/node";
import type { ServerDef, Timeouts } from "./config.ts";

const MAX_OPEN = 100;
const STDERR_TAIL = 4096;
const CLEAR_WAIT_MS = 500;
/** Requests that cover the whole workspace get the longer budget. */
const WORKSPACE_METHODS = new Set([
	"textDocument/references",
	"textDocument/rename",
	"textDocument/prepareRename",
	"workspace/symbol",
	"callHierarchy/incomingCalls",
	"callHierarchy/outgoingCalls",
	"workspace/willRenameFiles",
	"textDocument/codeAction",
	"codeAction/resolve",
	"workspace/executeCommand",
]);

export type Encoding = "utf-8" | "utf-16" | "utf-32";

interface OpenDoc {
	uri: string;
	languageId: string;
	version: number;
	text: string;
	/** Push revision when this version was sent; a later push is fresh for it. */
	sentAt: number;
}

interface Pushed {
	diagnostics: Diagnostic[];
	version?: number;
	revision: number;
}

export interface DiagnosticsResult {
	status: "fresh" | "timeout";
	items: Diagnostic[];
}

export class LspError extends Error {}

/** One running language server over stdio. */
export class LspClient {
	capabilities: ServerCapabilities = {};
	encoding: Encoding = "utf-16";
	serverName = "";
	stderr = "";
	/** Set once the process is gone or the connection broke; every later call throws it. */
	failure: LspError | undefined;
	private closing = false;
	private docs = new Map<string, OpenDoc>();
	private pushed = new Map<string, Pushed>();
	private pulled = new Map<string, { resultId?: string; items: Diagnostic[] }>();
	private silent = new Map<string, number>();
	private waiters = new Map<string, Set<() => void>>();
	private registrations = new Map<string, Registration>();
	private revision = 0;
	private syncing = new Map<string, Promise<OpenDoc>>();
	private running = 0;
	private queue: (() => void)[] = [];
	private failed: Promise<never>;
	private fail!: (error: LspError) => void;
	readonly def: ServerDef;
	readonly root: string;
	readonly timeouts: Timeouts;
	private child: ChildProcessWithoutNullStreams;
	private connection: ProtocolConnection;

	private constructor(def: ServerDef, root: string, timeouts: Timeouts, child: ChildProcessWithoutNullStreams, connection: ProtocolConnection, onExit: () => void) {
		this.def = def;
		this.root = root;
		this.timeouts = timeouts;
		this.child = child;
		this.connection = connection;
		this.failed = new Promise<never>((_resolve, reject) => {
			this.fail = (error) => {
				if (this.failure) return;
				this.failure = error;
				reject(error);
				onExit();
			};
		});
		this.failed.catch(() => undefined);
	}

	static async start(def: ServerDef, root: string, timeouts: Timeouts, onExit: () => void): Promise<LspClient> {
		const child = spawn(def.command, def.args, { cwd: root, env: def.env, stdio: ["pipe", "pipe", "pipe"] });
		const connection = createProtocolConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
		const client = new LspClient(def, root, timeouts, child, connection, onExit);
		client.bind();
		connection.listen();
		try {
			await client.initialize();
			return client;
		} catch (error) {
			await client.kill();
			throw new LspError(`${def.id}: ${(error as Error).message}${client.stderr ? `\n${client.stderr.trim().split("\n").slice(-5).join("\n")}` : ""}`);
		}
	}

	get alive(): boolean {
		return !this.failure && !this.closing;
	}

	private bind() {
		const { child, connection, def } = this;
		child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString()).slice(-STDERR_TAIL);
		});
		child.stdin.on("error", () => undefined);
		child.once("error", (error) => this.fail(new LspError(`${def.id} failed to start: ${error.message}`)));
		child.once("exit", (code, signal) => {
			if (!this.closing) this.fail(new LspError(`${def.id} exited with ${signal ?? `code ${code}`}`));
		});
		connection.onError(([error]) => this.fail(new LspError(`${def.id} connection failed: ${error.message}`)));
		connection.onClose(() => {
			if (!this.closing) this.fail(new LspError(`${def.id} closed its connection`));
		});
		connection.onNotification("textDocument/publishDiagnostics", (params: PublishDiagnosticsParams) => {
			this.revision++;
			this.silent.delete(params.uri);
			this.pushed.set(params.uri, { diagnostics: params.diagnostics, version: params.version, revision: this.revision });
			for (const notify of this.waiters.get(params.uri) ?? []) notify();
		});
		connection.onRequest("workspace/configuration", (params: { items: { section?: string }[] }) =>
			params.items.map((item) => section(def.settings, item.section)),
		);
		connection.onRequest("workspace/workspaceFolders", () => [{ name: def.id, uri: pathToFileURL(this.root).href }]);
		connection.onRequest("client/registerCapability", (params: { registrations: Registration[] }) => {
			for (const registration of params.registrations) this.registrations.set(registration.id, registration);
		});
		connection.onRequest("client/unregisterCapability", (params: { unregisterations: { id: string }[] }) => {
			for (const registration of params.unregisterations) this.registrations.delete(registration.id);
		});
		connection.onRequest("window/workDoneProgress/create", () => null);
		connection.onRequest("workspace/diagnostic/refresh", () => null);
		connection.onRequest("window/showMessageRequest", () => null);
		// Edits reach files only through a preview the agent applies.
		connection.onRequest("workspace/applyEdit", () => ({ applied: false, failureReason: "pi applies workspace edits only through an lsp preview" }));
		connection.onNotification("window/logMessage", () => undefined);
		connection.onNotification("window/showMessage", () => undefined);
		connection.onNotification("$/progress", () => undefined);
	}

	private async initialize() {
		const rootUri = pathToFileURL(this.root).href;
		const docs = ["markdown", "plaintext"];
		const result = await this.request<InitializeResult>(
			"initialize",
			{
				processId: process.pid,
				rootUri,
				rootPath: this.root,
				workspaceFolders: [{ name: this.def.id, uri: rootUri }],
				initializationOptions: this.def.initializationOptions ?? null,
				capabilities: {
					general: { positionEncodings: ["utf-8", "utf-16", "utf-32"] },
					window: { workDoneProgress: true },
					workspace: {
						applyEdit: true,
						configuration: true,
						workspaceFolders: true,
						diagnostics: { refreshSupport: true },
						workspaceEdit: { documentChanges: true, resourceOperations: ["create", "rename", "delete"], failureHandling: "abort" },
						symbol: { dynamicRegistration: true },
						fileOperations: { willRename: true },
					},
					textDocument: {
						synchronization: { didSave: true },
						publishDiagnostics: { relatedInformation: true, versionSupport: true },
						diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
						hover: { contentFormat: docs },
						definition: { linkSupport: true },
						typeDefinition: { linkSupport: true },
						implementation: { linkSupport: true },
						references: {},
						documentSymbol: { hierarchicalDocumentSymbolSupport: true },
						callHierarchy: {},
						rename: { prepareSupport: true },
						codeAction: {
							isPreferredSupport: true,
							resolveSupport: { properties: ["edit"] },
							codeActionLiteralSupport: {
								codeActionKind: { valueSet: ["", "quickfix", "refactor", "refactor.extract", "refactor.inline", "refactor.rewrite", "source", "source.organizeImports", "source.fixAll"] },
							},
						},
					},
				},
			},
			{ timeoutMs: this.timeouts.initializeMs },
		);
		this.capabilities = result.capabilities;
		const encoding = result.capabilities.positionEncoding;
		this.encoding = encoding === "utf-8" || encoding === "utf-32" ? encoding : "utf-16";
		this.serverName = result.serverInfo ? `${result.serverInfo.name}${result.serverInfo.version ? ` ${result.serverInfo.version}` : ""}` : "";
		await this.connection.sendNotification("initialized", {});
		if (this.def.settings !== undefined) await this.connection.sendNotification("workspace/didChangeConfiguration", { settings: this.def.settings });
	}

	/** A request with a timeout; a timed-out or aborted request is cancelled while the connection is open. */
	async request<T>(method: string, params: unknown, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
		if (this.failure) throw this.failure;
		const budget = options.timeoutMs ?? (WORKSPACE_METHODS.has(method) ? this.timeouts.workspaceRequestMs : this.timeouts.requestMs);
		const source = new CancellationTokenSource();
		const cancel = () => {
			if (this.alive) source.cancel();
		};
		let timer: NodeJS.Timeout | undefined;
		const onAbort = () => cancel();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([
				this.connection.sendRequest<T>(method, params, source.token),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						cancel();
						reject(new LspError(`${this.def.id}: ${method} timed out after ${budget} ms`));
					}, budget);
					options.signal?.addEventListener("abort", () => reject(new LspError(`${method} aborted`)), { once: true });
				}),
				this.failed,
			]);
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			source.dispose();
		}
	}

	notify(method: string, params: unknown): Promise<void> {
		if (this.failure) throw this.failure;
		return this.connection.sendNotification(method, params);
	}

	/** Opens or updates a document from disk, or from `text` when given; calls on one file run in order. */
	sync(path: string, languageId: string, text?: string): Promise<OpenDoc> {
		const uri = pathToFileURL(resolve(path)).href;
		const previous = this.syncing.get(uri) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(() => this.syncNow(uri, languageId, text));
		this.syncing.set(uri, next);
		void next.finally(() => {
			if (this.syncing.get(uri) === next) this.syncing.delete(uri);
		}).catch(() => undefined);
		return next;
	}

	private async syncNow(uri: string, languageId: string, given?: string): Promise<OpenDoc> {
		if (this.failure) throw this.failure;
		const text = given ?? new TextDecoder("utf-8", { fatal: true }).decode(await readFile(fileURLToPath(uri)));
		const existing = this.docs.get(uri);
		this.docs.delete(uri);
		if (existing && existing.text === text && existing.languageId === languageId) {
			this.docs.set(uri, existing);
			return existing;
		}
		const doc: OpenDoc = { uri, languageId, text, version: (existing?.version ?? 0) + 1, sentAt: this.revision };
		this.silent.delete(uri);
		if (!existing || existing.languageId !== languageId) {
			if (existing) await this.notify("textDocument/didClose", { textDocument: { uri } });
			await this.notify("textDocument/didOpen", { textDocument: { uri, languageId, version: doc.version, text } });
		} else {
			await this.notify("textDocument/didChange", { textDocument: { uri, version: doc.version }, contentChanges: [{ text }] });
			const sync = this.capabilities.textDocumentSync;
			if (typeof sync === "object" && sync.save) await this.notify("textDocument/didSave", { textDocument: { uri }, text });
		}
		this.docs.set(uri, doc);
		while (this.docs.size > MAX_OPEN) {
			const oldest = this.docs.keys().next().value as string;
			this.docs.delete(oldest);
			this.pushed.delete(oldest);
			this.pulled.delete(oldest);
			await this.notify("textDocument/didClose", { textDocument: { uri: oldest } });
		}
		return doc;
	}

	/** Closes a document, such as one a rename moved away. */
	async close(path: string): Promise<void> {
		const uri = pathToFileURL(resolve(path)).href;
		if (!this.docs.delete(uri) || this.failure) return;
		this.pushed.delete(uri);
		this.pulled.delete(uri);
		await this.notify("textDocument/didClose", { textDocument: { uri } });
	}

	/** Absolute paths of the open documents, oldest first. */
	openPaths(): string[] {
		return [...this.docs.keys()].map((uri) => fileURLToPath(uri));
	}

	private pullProvider(): { identifier?: string; workspace: boolean } | undefined {
		const dynamic = [...this.registrations.values()].find((r) => r.method === "textDocument/diagnostic");
		const options = (dynamic?.registerOptions ?? this.capabilities.diagnosticProvider) as { identifier?: string; workspaceDiagnostics?: boolean } | undefined;
		if (!dynamic && !this.capabilities.diagnosticProvider) return undefined;
		return { identifier: options?.identifier, workspace: options?.workspaceDiagnostics === true };
	}

	/** The push revision now; a push after it is newer than anything received so far. */
	revisionNow(): number {
		return this.revision;
	}

	/** Diagnostics for a synced version: a push since it was sent (and since `after`), a pull, or a timeout. */
	async diagnostics(path: string, languageId: string, signal?: AbortSignal, after = -1, reopened = false): Promise<DiagnosticsResult> {
		const doc = await this.sync(path, languageId);
		const since = Math.max(doc.sentAt, after);
		const fresh = () => {
			const push = this.pushed.get(doc.uri);
			return push && push.revision > since && (push.version === undefined || push.version === doc.version) ? push.diagnostics : undefined;
		};
		const now = fresh();
		if (now) return { status: "fresh", items: now };
		const provider = this.pullProvider();
		if (!provider && this.silent.get(doc.uri) === doc.version) return { status: "timeout", items: [] };
		// A push server that last reported the file clean may stay silent while it stays clean, so wait less before reopening it.
		const quiet = !provider && !reopened && this.pushed.get(doc.uri)?.diagnostics.length === 0;
		const waitMs = quiet ? Math.min(1000, this.timeouts.diagnosticsMs) : this.timeouts.diagnosticsMs;
		const done = new AbortController();
		const both = signal ? AbortSignal.any([signal, done.signal]) : done.signal;
		const waitPush = new Promise<DiagnosticsResult>((resolveWait, reject) => {
			const check = () => {
				const items = fresh();
				if (items) resolveWait({ status: "fresh", items });
			};
			const set = this.waiters.get(doc.uri) ?? new Set();
			set.add(check);
			this.waiters.set(doc.uri, set);
			const timer = setTimeout(() => reject(new LspError("timeout")), waitMs);
			both.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					set.delete(check);
					reject(new LspError("aborted"));
				},
				{ once: true },
			);
		});
		const candidates = [waitPush];
		if (provider) candidates.push(this.pull(doc.uri, provider.identifier, both));
		try {
			return await Promise.any(candidates);
		} catch {
			if (signal?.aborted) throw new LspError("aborted");
			// typescript-language-server publishes nothing when a clean file stays clean; reopening makes it report the file.
			if (quiet && this.docs.get(doc.uri)?.version === doc.version) {
				// A server may clear a closed file's diagnostics; that push must land before the reopen, or it would read as the answer.
				const cleared = this.nextPush(doc.uri, CLEAR_WAIT_MS);
				await this.close(path);
				if (await cleared) return this.diagnostics(path, languageId, signal, after, true);
				return this.settled(path, languageId, signal);
			}
			if (!provider && this.docs.get(doc.uri)?.version === doc.version) this.silent.set(doc.uri, doc.version);
			return { status: "timeout", items: [] };
		} finally {
			done.abort();
		}
	}

	/**
	 * Diagnostics after a reopen whose clearing push has not come: it may still arrive first, so an
	 * empty push is the answer only when nothing follows it before the deadline.
	 */
	private async settled(path: string, languageId: string, signal?: AbortSignal): Promise<DiagnosticsResult> {
		const doc = await this.sync(path, languageId);
		const deadline = Date.now() + this.timeouts.diagnosticsMs;
		let seen = doc.sentAt;
		let latest: Diagnostic[] | undefined;
		while (Date.now() < deadline) {
			if (signal?.aborted) throw new LspError("aborted");
			await this.nextPush(doc.uri, deadline - Date.now());
			const push = this.pushed.get(doc.uri);
			if (!push || push.revision <= seen || (push.version !== undefined && push.version !== doc.version)) continue;
			seen = push.revision;
			if (push.diagnostics.length > 0) return { status: "fresh", items: push.diagnostics };
			latest = push.diagnostics;
		}
		return latest ? { status: "fresh", items: latest } : { status: "timeout", items: [] };
	}

	/** Resolves true at the next push for `uri`, or false after `ms`. */
	private nextPush(uri: string, ms: number): Promise<boolean> {
		return new Promise((done) => {
			const set = this.waiters.get(uri) ?? new Set();
			const finish = (pushed: boolean) => {
				clearTimeout(timer);
				set.delete(onPush);
				done(pushed);
			};
			const onPush = () => finish(true);
			const timer = setTimeout(() => finish(false), Math.max(0, ms));
			set.add(onPush);
			this.waiters.set(uri, set);
		});
	}

	private async pull(uri: string, identifier: string | undefined, signal: AbortSignal): Promise<DiagnosticsResult> {
		await this.slot(signal);
		try {
			const previous = this.pulled.get(uri);
			const report = await this.request<DocumentDiagnosticReport>(
				"textDocument/diagnostic",
				{ textDocument: { uri }, identifier, previousResultId: previous?.resultId },
				{ timeoutMs: this.timeouts.diagnosticsMs, signal },
			);
			if (report.kind === "unchanged") return { status: "fresh", items: previous?.items ?? [] };
			this.pulled.set(uri, { resultId: report.resultId, items: report.items });
			return { status: "fresh", items: report.items };
		} finally {
			this.running--;
			this.queue.shift()?.();
		}
	}

	/** Waits for one of the server's `maxConcurrentDiagnostics` slots. */
	private async slot(signal: AbortSignal) {
		if (this.running < this.def.maxConcurrentDiagnostics) {
			this.running++;
			return;
		}
		await new Promise<void>((resolveSlot, reject) => {
			const take = () => {
				this.running++;
				resolveSlot();
			};
			this.queue.push(take);
			signal.addEventListener(
				"abort",
				() => {
					this.queue = this.queue.filter((entry) => entry !== take);
					reject(new LspError("aborted"));
				},
				{ once: true },
			);
		});
	}

	async shutdown(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		if (!this.failure) {
			await this.request("shutdown", null, { timeoutMs: this.timeouts.shutdownMs }).catch(() => undefined);
			await Promise.resolve()
				.then(() => this.connection.sendNotification("exit"))
				.catch(() => undefined);
			await new Promise<void>((done) => {
				if (this.child.exitCode !== null || this.child.signalCode !== null) return done();
				const timer = setTimeout(done, this.timeouts.shutdownMs);
				this.child.once("exit", () => (clearTimeout(timer), done()));
			});
		}
		await this.kill();
	}

	private async kill() {
		this.closing = true;
		if (this.child.exitCode === null && this.child.signalCode === null) {
			this.child.kill();
			await new Promise<void>((done) => {
				const timer = setTimeout(() => (this.child.kill("SIGKILL"), done()), 1000);
				this.child.once("exit", () => (clearTimeout(timer), done()));
			});
		}
		this.connection.dispose();
	}
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** The value of a dotted settings section, as workspace/configuration asks for it. */
function section(settings: unknown, name: string | undefined): Json {
	if (!name) return (settings ?? null) as Json;
	let value: unknown = settings;
	for (const key of name.split(".")) {
		if (typeof value !== "object" || value === null) return null;
		value = (value as Record<string, unknown>)[key];
	}
	return (value ?? null) as Json;
}
