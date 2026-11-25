import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

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
