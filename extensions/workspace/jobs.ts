// pi loads each extension separately, so module-level state would not be shared between them.
const KEY = Symbol.for("pi-extensions.workspace.jobs.v1");

/** Work running past its tool call that is not a shell job: a background subagent, script, or CI watch. */
export interface TrackedJob {
	id: string;
	kind: string;
	label: string;
	started: number;
	ended?: number;
	status: "running" | "done" | "failed";
	/** What the work returned, once it settles. */
	result?: string;
	done: Promise<void>;
	kill?: () => void;
	/** Set once the job tool returned the result, so the work's own wake-up is not sent too. */
	claimed?: boolean;
}

const store = globalThis as typeof globalThis & { [KEY]?: Map<string, TrackedJob> };
const tracked = (store[KEY] ??= new Map());

/** Tracks `work` under `id` so the job tool can list, wait on, or kill it. */
export function trackJob(id: string, kind: string, label: string, work: Promise<{ text: string; failed?: boolean }>, kill?: () => void): TrackedJob {
	const job: TrackedJob = { id, kind, label, started: Date.now(), status: "running", done: Promise.resolve(), kill };
	job.done = work.then(
		(value) => {
			job.status = value.failed ? "failed" : "done";
			job.result = value.text;
		},
		(error: Error) => {
			job.status = "failed";
			job.result = error.message;
		},
	).finally(() => {
		job.ended = Date.now();
	});
	tracked.set(id, job);
	return job;
}

export const trackedJob = (id: string) => tracked.get(id);
export const trackedJobs = () => [...tracked.values()];

/** Whether the job tool already handed this job's result to the agent. */
export const claimed = (id: string) => tracked.get(id)?.claimed === true;
