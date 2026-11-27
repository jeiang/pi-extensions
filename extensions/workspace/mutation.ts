import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { EditStore } from "@oh-my-pi/pi-natives";

// The workspace's hashline store, for writers in other extensions; pi loads each extension separately.
const STORE = Symbol.for("pi-extensions.workspace.editStore");
const holder = globalThis as typeof globalThis & { [STORE]?: EditStore };

export function shareEditStore(store: EditStore) {
	holder[STORE] = store;
}

/** Records content another tool wrote, so hashline edits see the file as it now is. */
export function recordWritten(path: string, content: string) {
	holder[STORE]?.recordSnapshot(path, content.replace(/\r\n?/g, "\n"), []);
}

/** pi's queue keys on the real path, so this must too: two names for one file would otherwise wait on each other. */
const key = (path: string) => {
	try {
		return realpathSync(resolve(path));
	} catch {
		return resolve(path);
	}
};

/** Serializes work on `paths` with pi's own queue, in a fixed order so two runs cannot deadlock. */
export function withFileLocks<T>(paths: string[], work: () => Promise<T>): Promise<T> {
	return [...new Set(paths.map(key))]
		.sort()
		.reduceRight<() => Promise<T>>((inner, path) => () => withFileMutationQueue(path, inner), work)();
}
