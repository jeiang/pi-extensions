import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface Review {
	/** False when every advisor model failed or timed out; the other fields are then empty. */
	answered: boolean;
	/** Blockers and concerns, empty when there are none. */
	serious: string;
	nits: string;
	usage?: Usage;
}

type Reviewer = (ctx: ExtensionContext, request: string, signal?: AbortSignal) => Promise<Review> | undefined;

// pi loads each extension separately, so a module-level map would not be shared between them.
const KEY = Symbol.for("pi-extensions.advisor.reviewers");
const store = globalThis as typeof globalThis & { [KEY]?: Map<string, Reviewer> };
const reviewers = (store[KEY] ??= new Map<string, Reviewer>());

export function setReviewer(ctx: ExtensionContext, reviewer: Reviewer) {
	reviewers.set(ctx.sessionManager.getSessionId(), reviewer);
}

/** The advisor's review of `request`, or undefined when the advisor is not loaded or is off in this session. */
export function askAdvisor(ctx: ExtensionContext, request: string, signal?: AbortSignal): Promise<Review> | undefined {
	return reviewers.get(ctx.sessionManager.getSessionId())?.(ctx, request, signal);
}
