import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const SOURCES = ["main", "advisor", "subagent", "tools", "other"] as const;
export type Source = (typeof SOURCES)[number];

export interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

const zero = (): Totals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

/** The sum of two usages; either may be absent. */
export function addUsage(first: Usage | undefined, second: Usage | undefined): Usage | undefined {
	if (!first || !second) return first ?? second;
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

const isUsage = (value: unknown): value is Usage => typeof (value as Usage | undefined)?.cost?.total === "number";

/** Which part of the session spent each entry's usage. */
function attribute(entry: SessionEntry): [Source, Usage] | undefined {
	if (entry.type === "message") {
		const { message } = entry;
		if (message.role === "assistant") return ["main", message.usage];
		if (message.role !== "toolResult" || !message.usage) return undefined;
		return [message.toolName === "advise" ? "advisor" : message.toolName === "subagent" ? "subagent" : "tools", message.usage];
	}
	if (entry.type === "usage") return ["main", entry.usage];
	if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) return ["other", entry.usage];
	// The advisor's own review at the end of a run is no tool call, so it records its usage in this entry.
	if (entry.type === "custom" && entry.customType === "advisor-usage" && isUsage(entry.data)) return ["advisor", entry.data];
	if (entry.type === "custom_message") {
		const usage = (entry.details as { usage?: unknown } | undefined)?.usage;
		if (isUsage(usage)) return [entry.customType === "subagent" ? "subagent" : "other", usage];
	}
	return undefined;
}

/** Token and cost totals of `entries` per source, plus their sum. */
export function costBreakdown(entries: readonly SessionEntry[]): { total: Totals; sources: Record<Source, Totals> } {
	const total = zero();
	const sources = Object.fromEntries(SOURCES.map((source) => [source, zero()])) as Record<Source, Totals>;
	for (const entry of entries) {
		const found = attribute(entry);
		if (!found) continue;
		const [source, usage] = found;
		for (const totals of [total, sources[source]]) {
			totals.input += usage.input;
			totals.output += usage.output;
			totals.cacheRead += usage.cacheRead;
			totals.cacheWrite += usage.cacheWrite;
			totals.cost += usage.cost.total;
		}
	}
	return { total, sources };
}
