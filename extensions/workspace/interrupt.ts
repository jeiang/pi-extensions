import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// pi loads each extension separately, so a module-level set would not be shared between them.
const KEY = Symbol.for("pi-extensions.workspace.interrupt");
const store = globalThis as typeof globalThis & { [KEY]?: Set<() => void> };
const running = (store[KEY] ??= new Set<() => void>());

/** Calls `detach` when the user interrupts; returns the function that stops listening. */
export function onInterrupt(detach: () => void): () => void {
	running.add(detach);
	return () => running.delete(detach);
}

/** Alt+Enter while an interruptible call runs detaches it and delivers the message as a steer instead of a follow-up. */
export function registerInterrupt(pi: ExtensionAPI) {
	pi.on("input", (event) => {
		if (event.streamingBehavior !== "followUp" || running.size === 0) return;
		for (const detach of running) detach();
		pi.sendUserMessage(event.images?.length ? [{ type: "text", text: event.text }, ...event.images] : event.text, { deliverAs: "steer" });
		return { action: "handled" };
	});
}

/**
 * Runs `work` to its end or until the user interrupts, then `background` holds the work still running.
 * `work` gets its own signal, which the call's `signal` aborts only until the call returns; `attached` turns false then.
 */
export async function untilInterrupt<T>(
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
	const stop = onInterrupt(interrupted.resolve);
	try {
		return (await Promise.race([result.then((value) => ({ value })), interrupted.promise])) ?? { background: result };
	} finally {
		attached = false;
		stop();
		signal?.removeEventListener("abort", cancel);
	}
}
