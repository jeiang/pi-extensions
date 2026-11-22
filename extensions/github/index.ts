import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { formatDuration } from "../turn-time/index.ts";
import { sessionDir } from "../workspace/cwd.ts";
import { registerInterrupt, untilInterrupt } from "../workspace/interrupt.ts";

const run = promisify(execFile);
const POLL_MS = 15_000;
const LOG_LINES = 80;

interface Step {
	name: string;
	status: string;
	conclusion: string | null;
	startedAt?: string | null;
	completedAt?: string | null;
}

interface Job extends Step {
	steps: Step[];
}

interface RunView {
	databaseId: number;
	name?: string;
	workflowName: string;
	status: string;
	conclusion: string | null;
	url: string;
	jobs: Job[];
}

interface Details {
	runs: RunView[];
}

const params = Type.Object({
	op: Type.Union([Type.Literal("run_watch"), Type.Literal("pr_view")], {
		description: "run_watch: watch CI runs until they finish or a job fails; pr_view: a pull request's state and checks.",
	}),
	run: Type.Optional(Type.String({ description: "run_watch: run id; default every run for the current HEAD commit." })),
	pr: Type.Optional(Type.String({ description: "pr_view: number, URL, or branch; default the current branch's PR." })),
});

async function gh<T>(cwd: string, args: string[]): Promise<T> {
	const { stdout } = await run("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
	return JSON.parse(stdout) as T;
}

async function ghText(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await run("gh", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
	return stdout;
}

const RUN_FIELDS = "databaseId,name,workflowName,status,conclusion,url,jobs";

const failed = (step: { conclusion: string | null }) => step.conclusion === "failure" || step.conclusion === "timed_out" || step.conclusion === "cancelled";
const elapsed = (step: Step) =>
	step.startedAt ? formatDuration((step.completedAt ? Date.parse(step.completedAt) : Date.now()) - Date.parse(step.startedAt)) : "";

function mark(step: Step, theme?: Theme): string {
	const paint = (color: "success" | "error" | "warning" | "muted", text: string) => (theme ? theme.fg(color, text) : text);
	if (step.status !== "completed") return paint("warning", "●");
	if (failed(step)) return paint("error", "✗");
	if (step.conclusion === "success") return paint("success", "✓");
	return paint("muted", "○");
}

export function renderRuns(runs: RunView[], theme?: Theme, expanded = false): string {
	return runs
		.map((r) => {
			const head = `${mark({ name: r.workflowName, status: r.status, conclusion: r.conclusion }, theme)} ${r.workflowName} ${r.url}`;
			const jobs = r.jobs.map((job) => {
				const row = `  ${mark(job, theme)} ${job.name} ${elapsed(job)}`;
				const showSteps = expanded || failed(job) || job.status !== "completed";
				const steps = showSteps
					? job.steps.filter((step) => expanded || step.status !== "completed" || failed(step)).map((step) => `      ${mark(step, theme)} ${step.name} ${elapsed(step)}`)
					: [];
				return [row, ...steps].join("\n");
			});
			return [head, ...jobs].join("\n");
		})
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	const shutdown = new AbortController();
	pi.on("session_shutdown", () => shutdown.abort());
	registerInterrupt(pi);
	pi.registerTool<typeof params, Details>({
		name: "github",
		label: "GitHub",
		description:
			"Watch GitHub Actions runs until they finish, failing fast with the failed job's log tail (run_watch), or show a pull request's state and checks (pr_view). If the user interrupts run_watch, it keeps watching in the background and wakes you with the outcome. Use `gh` through shell for everything else.",
		promptSnippet: "Watch CI runs (fail fast, failed log tail) and view PR state",
		parameters: params,
		exposure: "model-only",
		async execute(_id, input: Static<typeof params>, signal, onUpdate, ctx): Promise<AgentToolResult<Details>> {
			const cwd = sessionDir(ctx);
			if (input.op === "pr_view") {
				const pr = await gh<Record<string, unknown>>(cwd, [
					"pr",
					"view",
					...(input.pr ? [input.pr] : []),
					"--json",
					"number,title,state,url,headRefName,mergeable,reviewDecision,mergedAt,statusCheckRollup",
				]);
				return { content: [{ type: "text", text: JSON.stringify(pr, null, 2) }], details: { runs: [] } };
			}
			let ids: string[];
			if (input.run) ids = [input.run];
			else {
				const sha = (await run("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
				const listed = await gh<{ databaseId: number }[]>(cwd, ["run", "list", "--commit", sha, "--json", "databaseId"]);
				ids = listed.map((r) => String(r.databaseId));
				if (ids.length === 0) return { content: [{ type: "text", text: `No runs for ${sha} yet.` }], details: { runs: [] } };
			}
			const watch = async (signal: AbortSignal, attached: () => boolean): Promise<AgentToolResult<Details>> => {
				let runs: RunView[] = [];
				while (!signal.aborted) {
					runs = await Promise.all(ids.map((id) => gh<RunView>(cwd, ["run", "view", id, "--json", RUN_FIELDS])));
					if (attached()) onUpdate?.({ content: [{ type: "text", text: renderRuns(runs) }], details: { runs } });
					const failure = runs.find((r) => r.jobs.some(failed));
					if (failure || runs.every((r) => r.status === "completed")) break;
					await sleep(POLL_MS, undefined, { signal }).catch(() => undefined);
				}
				let text = renderRuns(runs, undefined, false);
				const failure = runs.find((r) => r.jobs.some(failed));
				if (failure) {
					const log = await ghText(cwd, ["run", "view", String(failure.databaseId), "--log-failed"]).catch((error: Error) => error.message);
					text += `\n\nFailed log tail (${failure.workflowName}):\n${log.trimEnd().split("\n").slice(-LOG_LINES).join("\n")}`;
				}
				return { content: [{ type: "text", text }], details: { runs }, isError: Boolean(failure) };
			};
			const outcome = await untilInterrupt(signal, (own, attached) => watch(AbortSignal.any([own, shutdown.signal]), attached));
			if ("value" in outcome) return outcome.value;
			const wake = (content: string, error: boolean) =>
				pi.sendMessage({ customType: "github", content, display: true, details: { error } }, { triggerTurn: true, deliverAs: "steer" });
			void outcome.background.then(
				(result) => {
					if (shutdown.signal.aborted) return;
					wake(`CI watch finished:\n${result.content.map((part) => (part.type === "text" ? part.text : "")).join("")}`, Boolean(result.isError));
				},
				(error: Error) => wake(`CI watch failed: ${error.message}`, true),
			);
			return { content: [{ type: "text", text: "The user interrupted; still watching CI in the background. You are woken with the outcome." }], details: { runs: [] } };
		},
		renderResult(result, options, theme) {
			const runs = result.details?.runs ?? [];
			if (runs.length === 0) return new Text(result.content.map((part) => (part.type === "text" ? part.text : "")).join(""), 0, 0);
			return new Text(renderRuns(runs, theme, options.expanded), 0, 0);
		},
	});
}
