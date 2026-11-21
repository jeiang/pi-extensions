import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export interface UsageWindow {
	label: string;
	percent: number;
	resetsAt?: number;
	/** Model-scoped windows stay out of the footer. */
	scoped?: boolean;
}

interface Source {
	provider: string;
	name: string;
	url: string;
	headers: Record<string, string>;
	parse(payload: unknown): UsageWindow[];
}

export type Report = { name: string; windows: UsageWindow[] } | { name: string; error: string };

const REFRESH_MS = 60_000;
const TIMEOUT_MS = 10_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function windowLabel(seconds: number): string {
	return seconds >= 86_400 ? `${Math.round(seconds / 86_400)}d` : `${Math.max(1, Math.round(seconds / 3600))}h`;
}

/** Anthropic `GET /api/oauth/usage`: the `limits` list (session, weekly_all, weekly_scoped). */
export function parseAnthropic(payload: unknown): UsageWindow[] {
	if (!isRecord(payload) || !Array.isArray(payload.limits)) return [];
	const labels: Record<string, string> = { session: "5h", weekly_all: "7d", weekly_scoped: "7d" };
	return payload.limits.flatMap((limit): UsageWindow[] => {
		if (!isRecord(limit) || typeof limit.kind !== "string" || typeof limit.percent !== "number") return [];
		const model = isRecord(limit.scope) && isRecord(limit.scope.model) ? limit.scope.model.display_name : undefined;
		const resetsAt = typeof limit.resets_at === "string" ? Date.parse(limit.resets_at) : Number.NaN;
		return [
			{
				label: [labels[limit.kind] ?? limit.kind, typeof model === "string" ? model : undefined].filter(Boolean).join(" "),
				percent: limit.percent,
				...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
				...(limit.scope ? { scoped: true } : {}),
			},
		];
	});
}

/** ChatGPT `GET /backend-api/wham/usage`: `rate_limit.primary_window` and `secondary_window`. */
export function parseCodex(payload: unknown): UsageWindow[] {
	if (!isRecord(payload) || !isRecord(payload.rate_limit)) return [];
	const rateLimit = payload.rate_limit;
	return [rateLimit.primary_window, rateLimit.secondary_window].flatMap((window): UsageWindow[] => {
		if (!isRecord(window) || typeof window.used_percent !== "number") return [];
		return [
			{
				label: typeof window.limit_window_seconds === "number" ? windowLabel(window.limit_window_seconds) : "window",
				percent: window.used_percent,
				...(typeof window.reset_at === "number" ? { resetsAt: window.reset_at * 1000 } : {}),
			},
		];
	});
}

const SOURCES: Source[] = [
	{
		provider: "anthropic",
		name: "claude",
		url: "https://api.anthropic.com/api/oauth/usage",
		headers: { "anthropic-beta": "oauth-2025-04-20" },
		parse: parseAnthropic,
	},
	{ provider: "openai-codex", name: "codex", url: "https://chatgpt.com/backend-api/wham/usage", headers: {}, parse: parseCodex },
];

/** Subscription usage of every OAuth-authenticated provider; API-key providers have none. */
async function fetchReports(ctx: ExtensionContext): Promise<Report[]> {
	const reports = await Promise.all(
		SOURCES.map(async (source): Promise<Report | undefined> => {
			const auth = await ctx.modelRegistry.getProviderAuth(source.provider).catch(() => undefined);
			if (auth?.source !== "OAuth" || !auth.auth.apiKey) return undefined;
			try {
				const response = await fetch(source.url, {
					headers: { ...source.headers, authorization: `Bearer ${auth.auth.apiKey}` },
					signal: AbortSignal.timeout(TIMEOUT_MS),
				});
				if (!response.ok) return { name: source.name, error: `HTTP ${response.status}` };
				return { name: source.name, windows: source.parse(await response.json()) };
			} catch (error) {
				return { name: source.name, error: error instanceof Error ? error.message : String(error) };
			}
		}),
	);
	return reports.filter((report) => report !== undefined);
}

// pi loads each extension separately, so the footer extension reads the reports from here.
const KEY = Symbol.for("pi-extensions.usage");
interface Shared {
	reports: Report[];
	onChange?: () => void;
}
const store = globalThis as typeof globalThis & { [KEY]?: Shared };
export const usageShared = (): Shared => (store[KEY] ??= { reports: [] });

export type UsageLevel = "success" | "warning" | "error";
const BAR_CELLS = 24;

export function usageLevel(percent: number): UsageLevel {
	return percent >= 80 ? "error" : percent >= 50 ? "warning" : "success";
}

function formatReset(resetsAt: number, now: number): string {
	const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	return `${Math.floor(hours / 24)}d${String(hours % 24).padStart(2, "0")}h`;
}

/** One bar per window: used, remaining, and the time to its reset. */
export function chartLines(reports: Report[], now: number, color: (level: UsageLevel, text: string) => string = (_level, text) => text): string[] {
	if (reports.length === 0) return ["No OAuth subscription logins for anthropic or openai-codex"];
	return reports.flatMap((report) => {
		if (!("windows" in report)) return [`${report.name}: ${report.error}`];
		const lines = report.windows.map((window) => {
			const used = Math.min(100, Math.max(0, Math.round(window.percent)));
			const filled = Math.round((used / 100) * BAR_CELLS);
			const bar = color(usageLevel(used), "█".repeat(filled)) + "░".repeat(BAR_CELLS - filled);
			const reset = window.resetsAt === undefined ? "" : `  resets in ${formatReset(window.resetsAt, now)}`;
			return `  ${window.label.padEnd(10)} ${bar} ${`${used}%`.padStart(4)} used ${`${100 - used}%`.padStart(4)} left${reset}`;
		});
		return [report.name, ...(lines.length > 0 ? lines : ["  no limits reported"])];
	});
}

interface Snapshot {
	reports: Report[];
	at: number;
}

/** Subscription usage limits (Claude, ChatGPT Codex): published for the footer extension, and charted by `/usage`. */
export default function (pi: ExtensionAPI) {
	let fetchedAt = 0;
	let pending: Promise<Report[]> | undefined;

	const refresh = (ctx: ExtensionContext, force = false): Promise<Report[]> | undefined => {
		if (pending) return pending;
		if (!force && Date.now() - fetchedAt < REFRESH_MS) return undefined;
		fetchedAt = Date.now();
		pending = fetchReports(ctx)
			.then((reports) => {
				const shared = usageShared();
				shared.reports = reports;
				shared.onChange?.();
				return reports;
			})
			.finally(() => {
				pending = undefined;
			});
		return pending;
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) void refresh(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.hasUI) void refresh(ctx);
	});

	pi.registerEntryRenderer<Snapshot>("usage", (entry, _options, theme) =>
		entry.data ? new Text(chartLines(entry.data.reports, entry.data.at, (level, text) => theme.fg(level, text)).join("\n"), 1, 0) : undefined,
	);

	pi.registerCommand("usage", {
		description: "Chart subscription usage limits for Claude and ChatGPT Codex",
		handler: async (_args, ctx) => {
			const snapshot: Snapshot = { reports: (await refresh(ctx, true)) ?? [], at: Date.now() };
			// An entry is drawn in the transcript and never sent to the model.
			if (ctx.mode === "tui") pi.appendEntry("usage", snapshot);
			else ctx.ui.notify(chartLines(snapshot.reports, snapshot.at).join("\n"), "info");
		},
	});
}
