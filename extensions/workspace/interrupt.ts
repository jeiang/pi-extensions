import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi loads each extension separately, so module-level state would not be shared between them.
const KEY = Symbol.for("pi-extensions.workspace.interrupt.v2");
type Calls = { running: Map<() => void, string>; background: Set<string> };
const store = globalThis as typeof globalThis & { [KEY]?: Calls };
const calls = (store[KEY] ??= { running: new Map(), background: new Set() });

/** Marks tool call `id` as running in the background until `work` settles, so an interrupt passes over the calls it makes. */
export function inBackground(id: string, work: Promise<unknown>) {
	calls.background.add(id);
	const done = () => void calls.background.delete(id);
	void work.then(done, done);
}

/**
 * Alt+Enter while an interruptible call runs detaches it and delivers the message as a steer instead of a follow-up.
 * A call nested in another (pi gives it the id `<parent>/<n>`) is left to its outermost interruptible or background caller.
 */
export function registerInterrupt(pi: ExtensionAPI) {
	pi.on("input", (event) => {
		if (event.streamingBehavior !== "followUp") return;
		const owners = [...calls.running.values(), ...calls.background];
		const outermost = [...calls.running].filter(([, id]) => !owners.some((owner) => id.startsWith(`${owner}/`)));
		if (outermost.length === 0) return;
		for (const [detach] of outermost) detach();
		pi.sendUserMessage(event.images?.length ? [{ type: "text", text: event.text }, ...event.images] : event.text, { deliverAs: "steer" });
		return { action: "handled" };
	});
}

/**
 * Runs `work` for tool call `id` to its end or until the user interrupts, then `background` holds the work still running.
 * `work` gets its own signal, which the call's `signal` aborts only until the call returns; `attached` turns false then.
 */
export async function untilInterrupt<T>(
	id: string,
	signal: AbortSignal | undefined,
	work: (signal: AbortSignal, attached: () => boolean) => Promise<T>,
): Promise<{ value: T } | { background: Promise<T> }> {
	const controller = new AbortController();
	const cancel = () => controller.abort();
	if (signal?.aborted) cancel();
	signal?.addEventListener("abort", cancel, { once: true });
	let attached = true;
	const result = work(controller.signal, () => attached);
	const interrupted = Promise.withResolvers<void>();
	calls.running.set(interrupted.resolve, id);
	try {
		const outcome = (await Promise.race([result.then((value) => ({ value })), interrupted.promise])) ?? { background: result };
		if ("background" in outcome) inBackground(id, result);
		return outcome;
	} finally {
		attached = false;
		calls.running.delete(interrupted.resolve);
		signal?.removeEventListener("abort", cancel);
	}
}
