import { createHash } from "node:crypto";
import { LspClient } from "./client.ts";
import type { ServerDef, Timeouts } from "./config.ts";

/** Waits after the nth consecutive failed start or crash before trying again. */
const BACKOFF_MS = [0, 5_000, 30_000, 120_000, 600_000];

export interface Instance {
	def: ServerDef;
	root: string;
	client?: LspClient;
	starting?: Promise<LspClient>;
	failures: number;
	retryAt: number;
	lastError?: string;
	idle?: NodeJS.Timeout;
	warmed?: Promise<void>;
}

// One pool per process, shared by every session pi runs in it.
const KEY = Symbol.for("pi-extensions.lsp.pool");
const holder = globalThis as typeof globalThis & { [KEY]?: Map<string, Instance> };
export const instances = (holder[KEY] ??= new Map<string, Instance>());

const fingerprint = (def: ServerDef) =>
	createHash("sha256")
		.update(JSON.stringify([def.command, def.args, def.initializationOptions, def.settings]))
		.digest("hex")
		.slice(0, 8);

/** The running client for a server in a root, started on first use; it stops after `idleMinutes` unused. */
export async function clientFor(def: ServerDef, root: string, timeouts: Timeouts, idleMinutes: number): Promise<LspClient> {
	const key = `${def.id}\0${root}\0${fingerprint(def)}`;
	let instance = instances.get(key);
	if (!instance) {
		instance = { def, root, failures: 0, retryAt: 0 };
		instances.set(key, instance);
	}
	const entry = instance;
	if (entry.idle) clearTimeout(entry.idle);
	entry.idle = setTimeout(() => void stopInstance(key), idleMinutes * 60_000);
	entry.idle.unref();
	if (entry.client?.alive) return entry.client;
	if (entry.starting) return entry.starting;
	if (Date.now() < entry.retryAt)
		throw new Error(`${def.id} is unavailable (${entry.lastError ?? "failed"}); retrying in ${Math.ceil((entry.retryAt - Date.now()) / 1000)}s, or /lsp restart`);
	const failed = (message: string) => {
		entry.failures++;
		entry.lastError = message;
		entry.retryAt = Date.now() + (BACKOFF_MS[Math.min(entry.failures, BACKOFF_MS.length - 1)] ?? 0);
	};
	entry.client = undefined;
	entry.warmed = undefined;
	entry.starting = LspClient.start(def, root, timeouts, () => {
		failed(entry.client?.failure?.message ?? "exited");
		entry.client = undefined;
	}).then(
		(client) => {
			entry.client = client;
			entry.starting = undefined;
			entry.failures = 0;
			entry.lastError = undefined;
			return client;
		},
		(error: Error) => {
			entry.starting = undefined;
			failed(error.message);
			throw error;
		},
	);
	return entry.starting;
}

async function stopInstance(key: string) {
	const instance = instances.get(key);
	if (!instance) return;
	instances.delete(key);
	if (instance.idle) clearTimeout(instance.idle);
	const client = instance.client ?? (await instance.starting?.catch(() => undefined));
	await client?.shutdown();
}

/** Stops matching instances; with no server, all of them. Returns how many stopped. */
export async function stopInstances(server?: string): Promise<number> {
	const keys = [...instances].filter(([, instance]) => !server || instance.def.id === server).map(([key]) => key);
	await Promise.all(keys.map(stopInstance));
	return keys.length;
}
