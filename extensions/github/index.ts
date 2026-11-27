import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify, stripVTControlCharacters } from "node:util";
import type { AgentToolResult, ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { formatDuration } from "../turn-time/index.ts";
import { sessionDir } from "../workspace/cwd.ts";
import { registerInterrupt, untilInterrupt } from "../workspace/interrupt.ts";
import { claimed, trackJob } from "../workspace/jobs.ts";

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

const OPS = [
	"pr_view",
	"pr_create",
	"pr_merge",
	"pr_watch",
	"pr_list",
	"pr_comment",
	"pr_close",
	"pr_edit",
	"run_watch",
	"run_log",
	"run_list",
	"workflow_run",
	"repo_file",
	"repo_tree",
	"api",
] as const;
type Op = (typeof OPS)[number];

const params = Type.Object({
	op: Type.Union(
		OPS.map((op) => Type.Literal(op)),
		{
			description:
				"pr_view: state, checks, merge state. pr_create: open one (push: true pushes the branch first). pr_merge: merge now, or with auto once checks pass. pr_watch: wait until the PR merges or closes (until: checks, until its checks finish), failing fast on a failed check. pr_list: find PRs, e.g. by head branch. pr_comment, pr_close, pr_edit. run_watch: watch a commit's or PR's CI runs, failing fast with the failed log tail. run_log: a run's or job's log, filtered. run_list: recent runs. workflow_run: dispatch a workflow. repo_file, repo_tree: read a file or list paths at a ref, in any repository. api: a read-only GitHub API GET.",
		},
	),
	repo: Type.Optional(Type.String({ description: "owner/name to act on instead of the checkout's repository." })),
	cwd: Type.Optional(Type.String({ description: "Repository checkout to act on; an absolute path, or relative to the session directory. Default the session directory." })),
	pr: Type.Optional(Type.String({ description: "pr_*, run_watch: number, URL, or branch; default the current branch's PR." })),
	run: Type.Optional(Type.String({ description: "run_watch, run_log: run id." })),
	job: Type.Optional(Type.String({ description: "run_log: job id, instead of a whole run." })),
	ref: Type.Optional(Type.String({ description: "run_watch: commit or branch whose runs to watch (default HEAD). workflow_run: branch or tag. repo_file, repo_tree: commit, branch, or tag (default the default branch)." })),
	title: Type.Optional(Type.String({ description: "pr_create, pr_edit: title; pr_create without it takes the first commit's subject and body." })),
	body: Type.Optional(Type.String({ description: "pr_create, pr_edit, pr_comment, pr_close (as its comment): text." })),
	base: Type.Optional(Type.String({ description: "pr_create, pr_edit: base branch; default the repository's default branch." })),
	head: Type.Optional(Type.String({ description: "pr_create: head branch, default the current one. pr_list: only PRs from this branch." })),
	push: Type.Optional(Type.Boolean({ description: "pr_create: push the current branch to origin first." })),
	draft: Type.Optional(Type.Boolean({ description: "pr_create: open as a draft." })),
	method: Type.Optional(Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")], { description: "pr_merge: required." })),
	auto: Type.Optional(Type.Boolean({ description: "pr_merge: merge once required checks pass; a PR already mergeable merges now." })),
	delete_branch: Type.Optional(Type.Boolean({ description: "pr_merge, pr_close: delete the head branch." })),
	expect_head: Type.Optional(Type.String({ description: "pr_merge: refuse unless the PR's head commit starts with this sha." })),
	until: Type.Optional(Type.Union([Type.Literal("merged"), Type.Literal("checks")], { description: "pr_watch: merged (default; also ends when closed) or checks (every check finished)." })),
	timeout: Type.Optional(Type.Number({ description: "pr_watch: seconds before it gives up with conclusion pending (default 3600)." })),
	state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("merged"), Type.Literal("all")], { description: "pr_list: default open." })),
	branch: Type.Optional(Type.String({ description: "run_list: only runs on this branch." })),
	commit: Type.Optional(Type.String({ description: "run_list: only runs for this commit sha." })),
	workflow: Type.Optional(Type.String({ description: "run_list: only this workflow. workflow_run: the workflow file name or id." })),
	inputs: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "workflow_run: workflow_dispatch inputs." })),
	limit: Type.Optional(Type.Number({ description: "pr_list, run_list: most results (default 20)." })),
	failed: Type.Optional(Type.Boolean({ description: "run_log: only the failed steps' log." })),
	grep: Type.Optional(Type.String({ description: "run_log: keep only lines matching this regex, with 2 lines of context." })),
	tail: Type.Optional(Type.Number({ description: "run_log: last N lines (default 200)." })),
	path: Type.Optional(Type.String({ description: "repo_file: file path. repo_tree: only paths under this directory. api: the endpoint, e.g. repos/{owner}/{repo}/releases." })),
	jq: Type.Optional(Type.String({ description: "api: a jq filter gh applies to the response." })),
});
type Params = Static<typeof params>;

const check = Type.Object({ name: Type.String(), status: Type.String(), conclusion: Type.Union([Type.String(), Type.Null()]), url: Type.Optional(Type.String()) });
const prShape = Type.Object({
	number: Type.Number(),
	title: Type.String(),
	state: Type.String({ description: "OPEN, CLOSED, or MERGED" }),
	url: Type.String(),
	branch: Type.String(),
	head_sha: Type.String(),
	draft: Type.Boolean(),
	mergeable: Type.String(),
	merge_state: Type.String({ description: "CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT, or UNKNOWN" }),
	auto_merge: Type.Boolean({ description: "Whether auto-merge is on." }),
	reviewDecision: Type.Union([Type.String(), Type.Null()]),
	mergedAt: Type.Union([Type.String(), Type.Null()]),
	checks: Type.Array(check),
});
const outputSchema = Type.Object({
	op: Type.String(),
	pr: Type.Optional(prShape),
	prs: Type.Optional(Type.Array(Type.Object({ number: Type.Number(), title: Type.String(), state: Type.String(), url: Type.String(), branch: Type.String(), draft: Type.Boolean() }))),
	conclusion: Type.Optional(
		Type.String({
			description:
				"run_watch, pr_watch: success, failure, merged, closed, pending (stopped before the end), none (no runs or checks yet), or background (the user interrupted; you are woken later).",
		}),
	),
	runs: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.Number(),
				workflow: Type.String(),
				status: Type.String(),
				conclusion: Type.Union([Type.String(), Type.Null()]),
				url: Type.String(),
				failed_jobs: Type.Array(Type.String()),
				branch: Type.Optional(Type.String()),
				sha: Type.Optional(Type.String()),
			}),
		),
	),
	failed_log: Type.Optional(Type.String({ description: "The failed job's log tail." })),
	output: Type.Optional(Type.String({ description: "run_log, repo_file, api: the text; pr_comment: the comment URL; workflow_run: gh's message." })),
	paths: Type.Optional(Type.Array(Type.String(), { description: "repo_tree: file paths." })),
});
type Output = Static<typeof outputSchema>;

interface PrView {
	number: number;
	title: string;
	state: string;
	url: string;
	headRefName: string;
	headRefOid: string;
	isDraft: boolean;
	mergeable: string;
	mergeStateStatus: string;
	autoMergeRequest: unknown;
	reviewDecision: string | null;
	mergedAt: string | null;
	statusCheckRollup?: { name?: string; context?: string; status?: string; state?: string; conclusion?: string | null; detailsUrl?: string; targetUrl?: string }[];
}
const PR_FIELDS = "number,title,state,url,headRefName,headRefOid,isDraft,mergeable,mergeStateStatus,autoMergeRequest,reviewDecision,mergedAt,statusCheckRollup";

/** CheckRuns and commit StatusContexts in one shape. */
function checksOf(pr: PrView): Static<typeof check>[] {
	return (pr.statusCheckRollup ?? []).map((c) => ({
		name: c.name ?? c.context ?? "",
		status: c.status ?? (c.state === "PENDING" || c.state === "EXPECTED" ? "IN_PROGRESS" : "COMPLETED"),
		conclusion: c.conclusion ?? (c.state && c.state !== "PENDING" && c.state !== "EXPECTED" ? c.state : null),
		...((c.detailsUrl ?? c.targetUrl) ? { url: c.detailsUrl ?? c.targetUrl } : {}),
	}));
}

const runsOf = (runs: RunView[]): NonNullable<Output["runs"]> =>
	runs.map((r) => ({
		id: r.databaseId,
		workflow: r.workflowName,
		status: r.status,
		conclusion: r.conclusion,
		url: r.url,
		failed_jobs: r.jobs.filter(failed).map((job) => job.name),
	}));

/** Where gh runs: the checkout, and a repository that overrides it (GH_REPO, which gh api's {owner}/{repo} follows too). */
interface Target {
	cwd: string;
	repo?: string;
}

/** GitHub's own hiccups, worth another try: a 5xx, a gateway error, or GraphQL's "Something went wrong". */
export const TRANSIENT = /HTTP 5\d\d|\b50[0234]\b|Bad Gateway|Service Unavailable|Something went wrong|ECONNRESET|ETIMEDOUT|i\/o timeout/i;
const ATTEMPTS = 3;

/** Runs gh, trying a read again after a transient failure; a write tries again only when `settled` finds it did not happen. */
async function ghRun(target: Target, args: string[], settled?: () => Promise<boolean>): Promise<{ stdout: string; stderr: string }> {
	const env = target.repo ? { ...process.env, GH_REPO: target.repo } : process.env;
	for (let attempt = 1; ; attempt++) {
		try {
			return await run("gh", args, { cwd: target.cwd, env, maxBuffer: 32 * 1024 * 1024 });
		} catch (error) {
			const message = `${(error as { stderr?: string }).stderr ?? ""}\n${(error as Error).message}`;
			if (attempt >= ATTEMPTS || !TRANSIENT.test(message)) throw new Error(((error as { stderr?: string }).stderr || (error as Error).message).trim());
			await sleep(2000 * attempt);
			if (settled && (await settled().catch(() => false))) return { stdout: "", stderr: "" };
		}
	}
}

async function gh<T>(target: Target, args: string[]): Promise<T> {
	return JSON.parse((await ghRun(target, args)).stdout) as T;
}

async function ghText(target: Target, args: string[]): Promise<string> {
	return (await ghRun(target, args)).stdout;
}

const RUN_FIELDS = "databaseId,name,workflowName,status,conclusion,url,jobs";

/** The conclusions that count as done: anything else a completed run or step reports, such as startup_failure or action_required, failed. */
const SUCCEEDED = new Set(["success", "neutral", "skipped"]);
/** gh gives an unfinished run or step an empty conclusion and a finished one its verdict. */
const failed = (step: { conclusion: string | null }) => (step.conclusion ? !SUCCEEDED.has(step.conclusion) : false);
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

/** The PR as scripts get it. */
function prOf(found: PrView): Static<typeof prShape> {
	return {
		number: found.number,
		title: found.title,
		state: found.state,
		url: found.url,
		branch: found.headRefName,
		head_sha: found.headRefOid,
		draft: found.isDraft,
		mergeable: found.mergeable,
		merge_state: found.mergeStateStatus,
		auto_merge: Boolean(found.autoMergeRequest),
		reviewDecision: found.reviewDecision,
		mergedAt: found.mergedAt,
		checks: checksOf(found),
	};
}

/** A check that finished without passing. */
const failedCheck = (c: Static<typeof check>) => c.status === "COMPLETED" && c.conclusion !== null && !SUCCEEDED.has(c.conclusion.toLowerCase());

/** Lines matching `pattern` with `context` lines around them, then the last `tail` of those. */
export function filterLog(log: string, pattern: string | undefined, tail: number, context = 2): string {
	let rows = stripVTControlCharacters(log).replace(/\n$/, "").split("\n");
	if (pattern) {
		const re = new RegExp(pattern);
		const keep = new Set<number>();
		rows.forEach((row, i) => {
			if (!re.test(row)) return;
			for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep.add(j);
		});
		rows = rows.filter((_row, i) => keep.has(i));
	}
	return rows.slice(-tail).join("\n");
}

type Result = AgentToolResult<Details> & { structuredContent: Output; isError?: boolean };
const reply = (op: string, text: string, structured: Omit<Output, "op"> = {}, runs: RunView[] = []): Result => ({
	content: [{ type: "text", text }],
	details: { runs },
	structuredContent: { op, ...structured },
});

export default function (pi: ExtensionAPI) {
	const shutdown = new AbortController();
	pi.on("session_shutdown", () => shutdown.abort());
	registerInterrupt(pi);

	/** Runs a long watch until it ends or the user interrupts; then it keeps going as a job that wakes the session. */
	const detachable = async (id: string, label: string, op: string, work: (signal: AbortSignal, attached: () => boolean) => Promise<Result>, signal: AbortSignal | undefined): Promise<Result> => {
		const outcome = await untilInterrupt(id, signal, (own, attached) => work(AbortSignal.any([own, shutdown.signal]), attached));
		if ("value" in outcome) return outcome.value;
		// The wake waits a moment, so a job wait that returned the result claims it first.
		const wake = (content: string, error: boolean) =>
			setTimeout(() => {
				if (!claimed(id) && !shutdown.signal.aborted) pi.sendMessage({ customType: "github", content, display: true, details: { error } }, { triggerTurn: true, deliverAs: "steer" });
			}, 200);
		const textOf = (result: Result) => result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
		trackJob(id, "github watch", label, outcome.background.then((result) => ({ text: textOf(result), failed: Boolean(result.isError) })));
		void outcome.background.then(
			(result) => wake(`${label} finished:\n${textOf(result)}`, Boolean(result.isError)),
			(error: Error) => wake(`${label} failed: ${error.message}`, true),
		);
		return reply(op, `The user interrupted; ${label} keeps going in the background. You are woken with the outcome, or job waits on it as ${id}.`, { conclusion: "background" });
	};

	pi.registerTool<typeof params, Details>({
		name: "github",
		label: "GitHub",
		description:
			"Pull requests, CI runs, and repository content on GitHub, in this checkout's repository or any owner/name in repo. Waits: pr_watch waits for a PR to merge or close, or with until: checks for its checks to finish, failing fast on a failed check, without merging anything; run_watch watches a commit's or PR's runs with the failed log tail. If the user interrupts a watch, it keeps going in the background and wakes you; job waits on it. GitHub's transient errors are retried. Use instead of gh pr view/create/merge/checks/list/comment/close/edit, gh run watch/view/list, gh workflow run, gh api GETs, and curl on raw.githubusercontent.com. Scripts get { op, pr?, prs?, conclusion?, runs?, failed_log?, output?, paths? }.",
		promptSnippet: "Pull requests, CI watches and logs, workflow dispatch, and repository files on GitHub",
		parameters: params,
		outputSchema,
		async execute(id, input: Params, signal, onUpdate, ctx): Promise<Result> {
			const cwd = resolve(sessionDir(ctx), input.cwd ?? ".");
			// A missing cwd otherwise fails as a misleading "spawn gh ENOENT".
			if (!existsSync(cwd)) throw new Error(`No directory ${cwd}`);
			const target: Target = { cwd, repo: input.repo };
			const op = input.op;
			const need = (field: keyof Params) => {
				const value = input[field];
				if (value === undefined || value === "") throw new Error(`${op} needs ${field}.`);
				return value;
			};
			const fetchPr = (pr: string | undefined) => gh<PrView>(target, ["pr", "view", ...(pr ? [pr] : []), "--json", PR_FIELDS]);
			const view = async (pr: string | undefined, note = "") => {
				const found = await fetchPr(pr);
				const { statusCheckRollup: _rollup, ...rest } = found;
				return reply(op, `${note}${JSON.stringify({ ...rest, checks: checksOf(found) }, null, 2)}`, { pr: prOf(found) });
			};

			switch (op) {
				case "pr_view":
					return view(input.pr);
				case "pr_create": {
					if (input.push) await run("git", ["push", "-u", "origin", input.head ?? "HEAD"], { cwd });
					const args = ["pr", "create", ...(input.title ? ["--title", input.title, "--body", input.body ?? ""] : ["--fill-first", ...(input.body !== undefined ? ["--body", input.body] : [])])];
					if (input.base) args.push("--base", input.base);
					if (input.head) args.push("--head", input.head);
					if (input.draft) args.push("--draft");
					// A create that timed out may have opened the PR; find it before opening a second one.
					const head = input.head ?? (await run("git", ["branch", "--show-current"], { cwd }).then((r) => r.stdout.trim(), () => ""));
					const existing = async () => (head ? (await gh<{ url: string }[]>(target, ["pr", "list", "--head", head, "--json", "url"]))[0]?.url : undefined);
					try {
						const { stdout } = await ghRun(target, args, async () => Boolean(await existing()));
						const url = stdout.trim().split("\n").at(-1) || (await existing());
						return view(url);
					} catch (error) {
						const message = (error as Error).message;
						if (/must first push|--head flag/.test(message)) throw new Error(`${message}\nPass push: true to push the branch first.`);
						throw error;
					}
				}
				case "pr_merge": {
					const method = need("method") as string;
					if (input.expect_head) {
						const found = await fetchPr(input.pr);
						if (!found.headRefOid.startsWith(input.expect_head)) throw new Error(`PR #${found.number} (${found.headRefName}) has head ${found.headRefOid}, not ${input.expect_head}; nothing merged.`);
					}
					const args = ["pr", "merge", ...(input.pr ? [input.pr] : []), `--${method}`, ...(input.delete_branch ? ["--delete-branch"] : [])];
					const merged = async () => Boolean((await fetchPr(input.pr)).mergedAt);
					let notes: string;
					try {
						notes = (await ghRun(target, [...args, ...(input.auto ? ["--auto"] : [])], merged)).stderr;
					} catch (error) {
						// GitHub refuses auto-merge for a PR that is mergeable already; merge it now instead.
						if (!input.auto || !/clean status|enablePullRequestAutoMerge|auto-merge is not allowed|Protected branch rules not configured/i.test((error as Error).message)) throw error;
						notes = `Auto-merge was refused (${(error as Error).message.split("\n")[0]}); merged now instead.\n${(await ghRun(target, args, merged)).stderr}`;
					}
					// gh notes on stderr when it cannot delete a branch checked out in a worktree; the merge still happened.
					return view(input.pr, notes.trim() ? `${notes.trim()}\n` : "");
				}
				case "pr_watch": {
					const until = input.until ?? "merged";
					const deadline = Date.now() + (input.timeout ?? 3600) * 1000;
					const started = Date.now();
					return detachable(id, `pr_watch ${input.pr ?? "current branch"}`, op, async (watchSignal, attached) => {
						for (;;) {
							const found = await fetchPr(input.pr);
							const pr = prOf(found);
							const failing = pr.checks.filter(failedCheck);
							const pending = pr.checks.filter((c) => c.status !== "COMPLETED");
							const status = `PR #${pr.number} ${pr.state}, merge state ${pr.merge_state}${pr.auto_merge ? ", auto-merge on" : ""}; checks: ${pr.checks.length - pending.length}/${pr.checks.length} done${failing.length ? `, failed: ${failing.map((c) => c.name).join(", ")}` : ""}`;
							if (attached()) onUpdate?.({ content: [{ type: "text", text: status }], details: { runs: [] } });
							const done = (conclusion: string, isError = false): Result => ({ ...reply(op, `${status}\n${pr.url}`, { pr, conclusion }), isError });
							if (pr.state === "MERGED") return done("merged");
							if (pr.state === "CLOSED") return done("closed", until === "merged");
							if (failing.length > 0) return done("failure", true);
							if (until === "checks" && pr.checks.length > 0 && pending.length === 0) return done("success");
							if (until === "checks" && pr.checks.length === 0 && Date.now() - started > 120_000) return done("none");
							if (Date.now() > deadline || watchSignal.aborted) return done("pending");
							await sleep(POLL_MS, undefined, { signal: watchSignal }).catch(() => undefined);
						}
					}, signal);
				}
				case "pr_list": {
					const args = ["pr", "list", "--json", "number,title,state,url,headRefName,isDraft", "--limit", String(input.limit ?? 20), "--state", input.state ?? "open"];
					if (input.head) args.push("--head", input.head);
					const found = await gh<{ number: number; title: string; state: string; url: string; headRefName: string; isDraft: boolean }[]>(target, args);
					const prs = found.map((p) => ({ number: p.number, title: p.title, state: p.state, url: p.url, branch: p.headRefName, draft: p.isDraft }));
					return reply(op, prs.map((p) => `#${p.number} ${p.state} ${p.branch}: ${p.title} ${p.url}`).join("\n") || "No pull requests.", { prs });
				}
				case "pr_comment": {
					const url = (await ghRun(target, ["pr", "comment", ...(input.pr ? [input.pr] : []), "--body", need("body") as string])).stdout.trim();
					return reply(op, url, { output: url });
				}
				case "pr_close": {
					const args = ["pr", "close", ...(input.pr ? [input.pr] : []), ...(input.body ? ["--comment", input.body] : []), ...(input.delete_branch ? ["--delete-branch"] : [])];
					const { stderr } = await ghRun(target, args, async () => (await fetchPr(input.pr)).state !== "OPEN");
					return view(input.pr, stderr.trim() ? `${stderr.trim()}\n` : "");
				}
				case "pr_edit": {
					if (input.title === undefined && input.body === undefined && input.base === undefined) throw new Error("pr_edit needs title, body, or base.");
					const args = ["pr", "edit", ...(input.pr ? [input.pr] : [])];
					if (input.title !== undefined) args.push("--title", input.title);
					if (input.body !== undefined) args.push("--body", input.body);
					if (input.base !== undefined) args.push("--base", input.base);
					await ghRun(target, args);
					return view(input.pr);
				}
				case "run_list": {
					const args = ["run", "list", "--json", "databaseId,workflowName,status,conclusion,url,headBranch,headSha", "--limit", String(input.limit ?? 20)];
					if (input.branch) args.push("--branch", input.branch);
					if (input.commit) args.push("--commit", input.commit);
					if (input.workflow) args.push("--workflow", input.workflow);
					const found = await gh<{ databaseId: number; workflowName: string; status: string; conclusion: string | null; url: string; headBranch: string; headSha: string }[]>(target, args);
					const runs = found.map((r) => ({ id: r.databaseId, workflow: r.workflowName, status: r.status, conclusion: r.conclusion, url: r.url, failed_jobs: [], branch: r.headBranch, sha: r.headSha }));
					return reply(op, runs.map((r) => `${r.id} ${r.workflow} ${r.status}${r.conclusion ? ` ${r.conclusion}` : ""} ${r.branch}@${r.sha.slice(0, 7)} ${r.url}`).join("\n") || "No runs.", { runs });
				}
				case "run_log": {
					if (!input.run && !input.job) throw new Error("run_log needs run or job.");
					const args = ["run", "view", ...(input.run ? [input.run] : []), ...(input.job ? ["--job", input.job] : []), input.failed ? "--log-failed" : "--log"];
					const output = filterLog(await ghText(target, args), input.grep, input.tail ?? 200);
					return reply(op, output || "(no matching lines)", { output });
				}
				case "workflow_run": {
					const args = ["workflow", "run", need("workflow") as string, ...(input.ref ? ["--ref", input.ref] : [])];
					for (const [key, value] of Object.entries(input.inputs ?? {})) args.push("-f", `${key}=${value}`);
					const { stdout, stderr } = await ghRun(target, args);
					const output = `${stdout}${stderr}`.trim() || "Dispatched.";
					return reply(op, `${output}\nrun_list with workflow finds the run; run_watch with run watches it.`, { output });
				}
				case "repo_file": {
					const path = (need("path") as string).replace(/^\/+/, "");
					const ref = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : "";
					const output = await ghText(target, ["api", "-H", "Accept: application/vnd.github.raw", `repos/{owner}/{repo}/contents/${path}${ref}`]);
					return reply(op, output, { output });
				}
				case "repo_tree": {
					const ref = input.ref ?? (await gh<{ default_branch: string }>(target, ["api", "repos/{owner}/{repo}"])).default_branch;
					const tree = await gh<{ tree: { path: string; type: string }[]; truncated: boolean }>(target, ["api", `repos/{owner}/{repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`]);
					const prefix = input.path ? `${input.path.replace(/^\/+|\/+$/g, "")}/` : "";
					const paths = tree.tree.filter((entry) => entry.type === "blob" && entry.path.startsWith(prefix)).map((entry) => entry.path);
					const note = tree.truncated ? "\n[GitHub truncated the tree; pass path to narrow it]" : "";
					return reply(op, `${paths.join("\n") || "No files."}${note}`, { paths });
				}
				case "api": {
					const path = need("path") as string;
					const output = await ghText(target, ["api", "--method", "GET", path, ...(input.jq ? ["--jq", input.jq] : [])]);
					return reply(op, output, { output });
				}
				case "run_watch":
					break;
			}

			let ids: string[];
			let label: string;
			if (input.run) {
				ids = [input.run];
				label = `run_watch ${input.run}`;
			} else {
				// A PR's runs are its head commit's; a ref resolves locally, or on GitHub for another repository.
				const sha = input.pr
					? (await fetchPr(input.pr)).headRefOid
					: input.repo
						? (await gh<{ sha: string }>(target, ["api", `repos/{owner}/{repo}/commits/${encodeURIComponent(input.ref ?? "HEAD")}`])).sha
						: (await run("git", ["rev-parse", input.ref ?? "HEAD"], { cwd })).stdout.trim();
				const listed = await gh<{ databaseId: number }[]>(target, ["run", "list", "--commit", sha, "--json", "databaseId"]);
				ids = listed.map((r) => String(r.databaseId));
				label = `run_watch ${input.pr ? `PR ${input.pr}` : (input.ref ?? "HEAD")}`;
				if (ids.length === 0) return reply(op, `No runs for ${sha} yet.`, { conclusion: "none", runs: [] });
			}
			return detachable(id, label, op, async (watchSignal, attached) => {
				let runs: RunView[] = [];
				while (!watchSignal.aborted) {
					runs = await Promise.all(ids.map((runId) => gh<RunView>(target, ["run", "view", runId, "--json", RUN_FIELDS])));
					if (attached()) onUpdate?.({ content: [{ type: "text", text: renderRuns(runs) }], details: { runs } });
					const failure = runs.find((r) => r.jobs.some(failed));
					if (failure || runs.every((r) => r.status === "completed")) break;
					await sleep(POLL_MS, undefined, { signal: watchSignal }).catch(() => undefined);
				}
				let text = renderRuns(runs, undefined, false);
				// A run can fail with no failed job, for example an invalid workflow file.
				const failure = runs.find((r) => failed(r) || r.jobs.some(failed));
				let failedLog: string | undefined;
				if (failure) {
					const log = await ghText(target, ["run", "view", String(failure.databaseId), "--log-failed"]).catch((error: Error) => error.message);
					failedLog = log.trimEnd().split("\n").slice(-LOG_LINES).join("\n");
					text += `\n\nFailed log tail (${failure.workflowName}):\n${failedLog}`;
				}
				const finished = runs.length > 0 && runs.every((r) => r.status === "completed");
				let conclusion = finished ? "success" : "pending";
				if (failure) conclusion = "failure";
				return { ...reply(op, text, { conclusion, runs: runsOf(runs), ...(failedLog ? { failed_log: failedLog } : {}) }, runs), isError: Boolean(failure) };
			}, signal);
		},
		renderResult(result, options, theme) {
			const runs = result.details?.runs ?? [];
			if (runs.length === 0) return new Text(result.content.map((part) => (part.type === "text" ? part.text : "")).join(""), 0, 0);
			return new Text(renderRuns(runs, theme, options.expanded), 0, 0);
		},
	});
}
