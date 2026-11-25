import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { askAdvisor, type Review } from "../advisor/review.ts";
import { effectsOf } from "../workspace/effects.ts";

const ENTRY = "plan";
const CONTEXT = "plan-mode-context";
const PROPOSAL = "plan-proposal";
const PROPOSE = "propose";
const REVIEW = "plan-review";
const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Survives the extension reload of a new session, whose session_start applies it. */
const HANDOFF = Symbol.for("pi-extensions.plan.handoff");

interface PlanState {
	enabled: boolean;
	/** The last proposed plan file. */
	file?: string;
}

interface Handoff {
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel;
}

const handoffSlot = globalThis as { [HANDOFF]?: Handoff };

function planDir(ctx: ExtensionContext): string {
	const file = ctx.sessionManager.getSessionFile();
	return file ? `${file.replace(/\.jsonl$/, "")}/plans` : join(tmpdir(), "pi-plans", ctx.sessionManager.getSessionId());
}

function insideDir(path: string, dir: string, cwd: string): boolean {
	const rel = relative(dir, resolve(cwd, path.replace(/^@/, "")));
	return rel !== "" && !rel.startsWith("..") && !rel.startsWith("/");
}

/** Why a tool call would change something outside the plan directory, or undefined when it may run. */
export function planViolation(tool: string, input: Record<string, unknown>, dir: string, cwd: string): string | undefined {
	const outside = `Plan mode: only files in ${dir} may change until the user approves the plan.`;
	const effect = effectsOf(tool, input, cwd);
	// A shell command, a subagent, or a tool nobody classified: the prompt forbids state changes, and only the model can tell.
	if (effect.kind === "read" || effect.kind === "opaque") return undefined;
	if (effect.kind === "mutate") {
		if (tool === "worktree") return "Plan mode: worktree changes wait until the user approves the plan.";
		if (tool === "github") return "Plan mode: pull request changes wait until the user approves the plan.";
		return outside;
	}
	if (tool === "edit" && typeof input.input === "string" && /^(REM|MV)\b/m.test(input.input)) return "Plan mode: deleting or renaming files is not allowed.";
	// No known target is not permission: a call nobody can place stays outside.
	if (effect.paths.length === 0) return outside;
	return effect.paths.every((path) => insideDir(path, dir, cwd)) ? undefined : outside;
}

function planningPrompt(dir: string): string {
	return `[PLAN MODE]
You are planning. The user reviews your plan before anything changes.

- Read-only: never create, edit, delete, or rename files outside ${dir}, and run no command that changes state (commits, installs, worktree creation, migrations, deploys, remote changes). Edit tools are blocked outside that directory.
- Find facts in the code and tools instead of asking. Ask the user, with the questionnaire tool, only about preferences or trade-offs that change the plan.
- Write the plan to ${dir}/<slug>.md, where <slug> is short kebab-case. It must stand alone: someone without this conversation executes it. Include the goal and context, the ordered concrete changes with file paths and symbols, how to verify each, and assumptions with what to do if one is wrong. Leave no design choice open, and do not refer to this conversation.
- When the plan is complete, call ${PROPOSE} with the slug. Never ask for approval in prose. After feedback, update the same file and call ${PROPOSE} again.`;
}

function executionPrompt(plan: string, file: string): string {
	return `Execute this approved plan step by step with full tool access. Verify each step before the next. The plan is also saved at ${file}.

${plan}`;
}

function advisorRequest(plan: string): string {
	return `The agent proposes the plan below for the user's approval; nothing has changed yet. Review the plan, not the run: flag a step that would fail or break something, a requirement or caller the transcript shows it misses, or an assumption it relies on that a cheap check would settle. Use the same labels, or answer LGTM.

<plan>
${plan}
</plan>`;
}

/** The plan file for `slug`: a slug never leaves `dir`, and a name that does not exist is not another plan. */
export function findPlan(dir: string, slug: string): string | undefined {
	const name = slug.replace(/\.md$/, "");
	if (!/^[\w-]+$/.test(name)) return undefined;
	const named = join(dir, `${name}.md`);
	return existsSync(named) ? named : undefined;
}

export default function (pi: ExtensionAPI) {
	let state: PlanState = { enabled: false };
	let reviewPending = false;
	let reviewing = false;
	/** Whether the advisor already sent this input's plan back; a second proposal goes straight to the user. */
	let advised = false;
	/** The advisor's nits on the proposed plan, shown on the review card. */
	let notes = "";

	const save = (next: PlanState, ctx: ExtensionContext) => {
		state = next;
		pi.appendEntry(ENTRY, state);
		ctx.ui.setStatus(ENTRY, state.enabled ? "plan" : undefined);
	};

	const setPropose = (on: boolean) => {
		const active = pi.getActiveTools().filter((name) => name !== PROPOSE);
		pi.setActiveTools(on ? [...active, PROPOSE] : active);
	};

	const enter = (ctx: ExtensionContext) => {
		setPropose(true);
		save({ ...state, enabled: true }, ctx);
		ctx.ui.notify(`Plan mode: the plan goes in ${planDir(ctx)}`, "info");
	};

	const exit = (ctx: ExtensionContext) => {
		setPropose(false);
		reviewPending = false;
		save({ ...state, enabled: false }, ctx);
	};

	const pickModel = async (ctx: ExtensionCommandContext): Promise<Handoff | undefined> => {
		const current = ctx.model;
		const models = ctx.scopedModels.length > 0 ? ctx.scopedModels.map((scoped) => scoped.model) : ctx.modelRegistry.getAvailable();
		const name = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
		const labels = [...new Set([...(current ? [`${name(current)} (current)`] : []), ...models.map(name).filter((n) => !current || n !== name(current))])];
		const choice = await ctx.ui.select("Model for the new session", labels);
		if (!choice) return undefined;
		const spec = choice.replace(/ \(current\)$/, "");
		const slash = spec.indexOf("/");
		const level = ctx.thinkingLevel ?? "medium";
		const levels = [`${level} (current)`, ...LEVELS.filter((l) => l !== level)];
		const thinking = await ctx.ui.select("Thinking level for the new session", levels);
		if (!thinking) return undefined;
		return { provider: spec.slice(0, slash), id: spec.slice(slash + 1), thinkingLevel: thinking.replace(/ \(current\)$/, "") as ThinkingLevel };
	};

	const review = async (ctx: ExtensionCommandContext) => {
		reviewPending = false;
		const file = state.file;
		if (!state.enabled || !file || !existsSync(file)) {
			ctx.ui.notify("No plan to review. Start one with /plan.", "warning");
			return;
		}
		const card = notes ? `${readFileSync(file, "utf8")}\n\n---\n\n**Advisor**\n\n${notes}` : readFileSync(file, "utf8");
		pi.sendMessage({ customType: PROPOSAL, content: card, display: true });
		for (;;) {
			const choice = await ctx.ui.select(`Plan: ${file}`, [
				"Approve and execute here",
				"Approve and execute in a new session",
				"Revise with feedback",
				"Edit the plan",
				"Not now",
			]);
			const plan = readFileSync(file, "utf8");
			if (choice === "Edit the plan") {
				const edited = await ctx.ui.editor("Edit the plan", plan);
				if (edited !== undefined && edited !== plan) writeFileSync(file, edited);
				continue;
			}
			if (choice === "Approve and execute here") {
				exit(ctx);
				pi.sendUserMessage(executionPrompt(plan, file));
				return;
			}
			if (choice === "Approve and execute in a new session") {
				const target = await pickModel(ctx);
				if (!target) continue;
				const kickoff = executionPrompt(plan, file);
				exit(ctx);
				handoffSlot[HANDOFF] = target;
				const result = await ctx.newSession({
					parentSession: ctx.sessionManager.getSessionFile(),
					withSession: async (next) => {
						await next.sendUserMessage(kickoff);
					},
				});
				if (result.cancelled) {
					delete handoffSlot[HANDOFF];
					ctx.ui.notify("New session cancelled; plan mode is off. Run /plan to resume planning.", "warning");
				}
				return;
			}
			if (choice === "Revise with feedback") {
				const feedback = await ctx.ui.editor("What should change in the plan?", "");
				if (!feedback?.trim()) continue;
				pi.sendUserMessage(feedback.trim());
				return;
			}
			ctx.ui.notify("Plan mode stays on. /plan-review reopens the plan; /plan leaves plan mode.", "info");
			return;
		}
	};

	pi.registerTool({
		name: PROPOSE,
		label: "Propose plan",
		description: "Submit the finished plan for the user's review. Call it once the plan file is written; the user approves, revises, or edits it.",
		parameters: Type.Object({
			title: Type.String({ description: "The plan's slug: the <slug> of <slug>.md in the plan directory." }),
		}),
		defaultActive: false,
		async execute(_id, params, signal, onUpdate, ctx) {
			if (!state.enabled) throw new Error("Plan mode is off.");
			const dir = planDir(ctx);
			const file = findPlan(dir, params.title);
			if (!file) throw new Error(`No plan in ${dir}. Write it to ${join(dir, `${params.title}.md`)} first.`);
			const pending = advised ? undefined : askAdvisor(ctx, advisorRequest(readFileSync(file, "utf8")), signal);
			if (pending) onUpdate?.({ content: [{ type: "text", text: "Advisor reviewing the plan…" }], details: { file } });
			const advice = await pending?.catch((): Review => ({ answered: false, serious: "", nits: "" }));
			if (advice?.serious) {
				advised = true;
				const text = `Advisor:\n${advice.serious}\n\nWeigh these points: fix the plan file for the ones the evidence supports, reject the others in one line each, then call ${PROPOSE} again.`;
				return { content: [{ type: "text", text }], details: { file }, usage: advice.usage };
			}
			notes = advice && !advice.answered ? "The advisor did not answer; this plan is unreviewed." : (advice?.nits ?? "");
			save({ ...state, file }, ctx);
			reviewPending = true;
			const verdict = !advice ? "" : !advice.answered ? " The advisor did not answer." : notes ? " The advisor left nits for the user." : " The advisor found no problems.";
			return { content: [{ type: "text", text: `Plan ready for review: ${file}.${verdict}` }], details: { file }, usage: advice?.usage, terminate: true };
		},
	});

	pi.registerCommand(ENTRY, {
		description: "Toggle plan mode: the agent writes a plan for review before changing anything",
		handler: async (args, ctx) => {
			const prompt = args.trim();
			if (state.enabled && !prompt) {
				exit(ctx);
				ctx.ui.notify("Plan mode off", "info");
				return;
			}
			if (!state.enabled) enter(ctx);
			if (prompt) pi.sendUserMessage(prompt, ctx.isIdle() ? undefined : { deliverAs: "steer" });
		},
	});

	pi.registerCommand(REVIEW, {
		description: "Review the proposed plan: approve, revise, or edit it",
		handler: async (_args, ctx) => {
			if (reviewing) {
				ctx.ui.notify("The plan review is already open.", "info");
				return;
			}
			reviewing = true;
			try {
				await ctx.waitForIdle();
				await review(ctx);
			} finally {
				reviewing = false;
			}
		},
	});

	pi.on("input", () => {
		advised = false;
	});

	pi.on("tool_call", (event, ctx) => {
		if (!state.enabled) return;
		const reason = planViolation(event.toolName, event.input as Record<string, unknown>, planDir(ctx), ctx.cwd);
		if (reason) return { block: true, reason };
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!state.enabled || event.messageType !== "user") return;
		return { message: { customType: CONTEXT, content: planningPrompt(planDir(ctx)), display: false } };
	});

	// The proposal card is for the user; old planning instructions would mislead the agent once it executes.
	pi.on("context", (event) => {
		const drop = (type: string | undefined) => type === PROPOSAL || (!state.enabled && type === CONTEXT);
		const messages = event.messages.filter((m) => !drop((m as { customType?: string }).customType));
		if (messages.length !== event.messages.length) return { messages };
	});

	pi.on("agent_settled", (event, ctx) => {
		if (!reviewPending || event.aborted || !ctx.hasUI) return;
		pi.sendUserMessage(`/${REVIEW}`, { expandPromptTemplates: true });
	});

	// pi appends state per branch, so a branch switch must re-read it; the handoff applies only to a new session.
	const restore = (_event: unknown, ctx: ExtensionContext) => {
		const entry = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && e.customType === ENTRY)
			.pop() as { data?: PlanState } | undefined;
		state = entry?.data ?? { enabled: false };
		setPropose(state.enabled);
		ctx.ui.setStatus(ENTRY, state.enabled ? "plan" : undefined);
	};

	pi.on("session_start", async (event, ctx) => {
		const handoff = handoffSlot[HANDOFF];
		delete handoffSlot[HANDOFF];
		if (event.reason === "new" && handoff) {
			const model = ctx.modelRegistry.find(handoff.provider, handoff.id);
			if (!model || !(await pi.setModel(model))) ctx.ui.notify(`Could not switch to ${handoff.provider}/${handoff.id}`, "error");
			pi.setThinkingLevel(handoff.thinkingLevel);
		}
		restore(event, ctx);
	});
	pi.on("session_tree", restore);
}
