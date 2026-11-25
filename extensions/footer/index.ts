import { execFile } from "node:child_process";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { usageLevel, usageShared } from "../usage/index.ts";
import { sessionDir } from "../workspace/cwd.ts";
import { costBreakdown, SOURCES, type Totals } from "./cost.ts";

const SEPARATOR = " \ue0b1 ";
const THINKING: Record<string, string> = {
	off: "\uf05e",
	minimal: "\u{f0a9e}",
	low: "\u{f0a9f}",
	medium: "\u{f0aa1}",
	high: "\u{f0aa3}",
	xhigh: "\u{f0aa5}",
	max: "\uf06d",
};
// Tools after which the working tree can differ.
const CHANGES_FILES: Record<string, true> = { edit: true, write: true, replace: true, substitute: true, shell: true, bash: true, codemode: true, worktree: true, github: true };
// The turn time has its own segment.
const OWN_STATUSES: Record<string, true> = { "turn-time": true };

export interface GitState {
	branch: string;
	unstaged: number;
	staged: number;
	untracked: number;
}

/** Reads `git status --porcelain=v2 --branch`. */
export function parseStatus(output: string): GitState {
	const state: GitState = { branch: "", unstaged: 0, staged: 0, untracked: 0 };
	for (const line of output.split("\n")) {
		if (line.startsWith("# branch.head ")) state.branch = line.slice("# branch.head ".length);
		else if (line.startsWith("? ")) state.untracked++;
		else if (/^[12u] /.test(line)) {
			if (line[2] !== ".") state.staged++;
			if (line[3] !== ".") state.unstaged++;
		}
	}
	return state;
}

const count = (tokens: number) =>
	tokens < 1000
		? `${tokens}`
		: (tokens < 1_000_000 ? `${(tokens / 1000).toFixed(1)}k` : `${(tokens / 1_000_000).toFixed(1)}M`).replace(".0", "");

/** The footer: one icon per segment, a color per group, and a thin separator between segments. */
export default function (pi: ExtensionAPI) {
	let git: GitState | undefined;
	let gitRunning = false;
	let gitStale = false;
	let totals: Totals = costBreakdown([]).total;
	let requestRender: (() => void) | undefined;

	// Off the render path: git status can be slow on a large repository, so the footer draws the last result.
	const refreshGit = (ctx: ExtensionContext) => {
		if (gitRunning) {
			gitStale = true;
			return;
		}
		gitRunning = true;
		execFile("git", ["status", "--porcelain=v2", "--branch"], { cwd: sessionDir(ctx), timeout: 5000 }, (error, stdout) => {
			git = error ? undefined : parseStatus(stdout);
			gitRunning = false;
			requestRender?.();
			if (gitStale) {
				gitStale = false;
				refreshGit(ctx);
			}
		});
	};

	const recount = (ctx: ExtensionContext) => {
		totals = costBreakdown(ctx.sessionManager.getBranch()).total;
	};

	const segments = (ctx: ExtensionContext, theme: Theme, statuses: ReadonlyMap<string, string>, fallbackBranch: string | null): string[] => {
		const out: string[] = [];
		const model = ctx.model ? (ctx.model.provider === "chain" ? `chain/${ctx.model.id}` : ctx.model.id) : "no model";
		// A chain sets the thinking level per target, so the session level says nothing.
		out.push(ctx.model?.provider === "chain" ? theme.fg("accent", model) : `${theme.fg("accent", model)} ${theme.fg("muted", THINKING[pi.getThinkingLevel()] ?? "")}`);

		const dir = sessionDir(ctx);
		const home = homedir();
		out.push(`${dir.includes("/.worktrees/") ? "\uf1bb" : "\uf07c"} ${dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir}`);

		const branch = git?.branch || fallbackBranch;
		if (branch) {
			const counts = git ? [git.unstaged && `*${git.unstaged}`, git.staged && `+${git.staged}`, git.untracked && `?${git.untracked}`].filter(Boolean).join(" ") : "";
			const color = git?.unstaged ? "warning" : git?.untracked ? "accent" : "success";
			out.push(theme.fg(color, `\ue725 ${branch}${counts ? ` ${counts}` : ""}`));
		}

		if (totals.input || totals.output) out.push(theme.fg("syntaxFunction", `\uf090 ${count(totals.input)} \uf08b ${count(totals.output)}`));
		if (totals.cacheRead || totals.cacheWrite) out.push(theme.fg("syntaxType", `\uf1c0 R ${count(totals.cacheRead)} W ${count(totals.cacheWrite)}`));
		if (totals.cost) out.push(theme.fg("syntaxNumber", `$${totals.cost.toFixed(2)}`));

		const usage = ctx.getContextUsage();
		if (usage?.percent != null) {
			const percent = usage.percent;
			const text = `\ue70f ${Math.round(percent)}% / ${count(usage.contextWindow)}`;
			out.push(percent >= 90 ? theme.fg("error", text) : percent >= 70 ? theme.bold(theme.fg("warning", text)) : theme.fg(percent >= 50 ? "warning" : "muted", text));
		}

		for (const report of usageShared().reports) {
			if (!("windows" in report)) continue;
			const windows = report.windows
				.filter((window) => !window.scoped)
				.map((window) => {
					const level = usageLevel(window.percent);
					return theme.fg(level === "success" ? "muted" : level, `${window.label} ${Math.round(window.percent)}%`);
				});
			if (windows.length > 0) out.push(`${theme.fg("muted", `\uf201 ${report.name}`)} ${windows.join(" ")}`);
		}

		const turn = statuses.get("turn-time");
		if (turn) out.push(theme.fg("muted", `\uf017 ${turn.replace(/^turn /, "")}`));
		return out;
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		recount(ctx);
		refreshGit(ctx);
		ctx.ui.setFooter((tui, theme, footerData) => {
			const render = () => tui.requestRender();
			requestRender = render;
			usageShared().onChange = render;
			const unsubscribe = footerData.onBranchChange(() => refreshGit(ctx));
			let last: string[] = [];
			return {
				dispose() {
					unsubscribe();
					// A new session's footer can be installed before this one is disposed.
					if (requestRender !== render) return;
					requestRender = undefined;
					usageShared().onChange = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					let parts: string[];
					const statuses = footerData.getExtensionStatuses();
					try {
						parts = segments(ctx, theme, statuses, footerData.getGitBranch());
					} catch {
						// ctx throws once the session is replaced; the next session_start installs a new footer.
						return last;
					}
					const separator = theme.fg("dim", SEPARATOR);
					const lines: string[] = [];
					let line = "";
					for (const part of parts) {
						const joined = line ? line + separator + part : part;
						if (line && visibleWidth(joined) > width) {
							lines.push(line);
							line = part;
						} else line = joined;
					}
					if (line) lines.push(line);
					// A status from any other extension shows here, as in pi's built-in footer.
					const others = [...statuses]
						.filter(([key]) => !OWN_STATUSES[key])
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => text.replace(/\s+/g, " "));
					if (others.length > 0) lines.push(theme.fg("dim", others.join(" ")));
					last = lines.map((text) => truncateToWidth(text, width));
					return last;
				},
			};
		});
	});

	const recountInTui = (_event: unknown, ctx: ExtensionContext) => {
		if (ctx.mode === "tui") recount(ctx);
	};
	pi.on("turn_end", recountInTui);
	pi.on("session_compact", recountInTui);
	pi.on("session_tree", recountInTui);
	pi.on("tool_result", (event, ctx) => {
		if (ctx.mode === "tui" && CHANGES_FILES[event.toolName]) refreshGit(ctx);
	});
	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// The advisor records its review's usage after the last turn ends.
		recount(ctx);
		refreshGit(ctx);
	});

	pi.registerCommand("cost", {
		description: "Show the cost and tokens of this branch per source: main agent, advisor, subagents, tools, and other (compaction, summaries)",
		handler: async (_args, ctx) => {
			const { total, sources } = costBreakdown(ctx.sessionManager.getBranch());
			const row = (name: string, part: Totals) =>
				`${name.padEnd(9)} $${part.cost.toFixed(2).padStart(7)}  in ${count(part.input)} out ${count(part.output)} cache R ${count(part.cacheRead)} W ${count(part.cacheWrite)}`;
			const rows = SOURCES.filter((source) => sources[source].cost || sources[source].input || sources[source].output).map((source) => row(source, sources[source]));
			ctx.ui.notify([row("total", total), ...rows].join("\n"), "info");
		},
	});
}
