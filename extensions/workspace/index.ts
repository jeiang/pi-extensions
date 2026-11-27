import {
	type BashOperations,
	createBashToolDefinition,
	createLocalBashOperations,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { EditStore } from "@oh-my-pi/pi-natives";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { type Static, type TObject, Type } from "typebox";
import { readableFolder, restrictedFolder } from "../guards/index.ts";
import { setSessionDir } from "./cwd.ts";
import { effectsOf } from "./effects.ts";
import { applyEnv, type Devshell, devshellStamp, resolveDevshell } from "./devshell.ts";
import { structuredGrep } from "./grep.ts";
import { hashlineTools } from "./hashline.ts";
import { registerInterrupt } from "./interrupt.ts";
import { readTextTool, structuredFind, structuredLs } from "./listing.ts";
import { registerShell } from "./shell.ts";
import { registerSsh } from "./ssh.ts";
import { registerSubagent } from "./subagent.ts";
import { substituteTool } from "./substitute.ts";
import {
	baseRef,
	carryChanges,
	checkoutRelative,
	createWorktree,
	deleteBranch,
	detectRepo,
	enterWorktree,
	fastForwardBranch,
	fastForwardMain,
	mergedBranch,
	ownWorktrees,
	pruneWorktrees,
	type Repo,
	removeWorktree,
	remapPath,
	slug,
	type Worktree,
} from "./worktree.ts";

const ENTRY = "workspace-worktree";

/** macOS names screenshots with a narrow no-break space before AM or PM; a typed path has a plain one. */
export function withNarrowSpaces(absolute: string): string | undefined {
	if (existsSync(absolute) || !/ (AM|PM)\b/.test(absolute)) return undefined;
	const narrow = absolute.replace(/ (AM|PM)\b/g, "\u202f$1");
	return existsSync(narrow) ? narrow : undefined;
}
const NEEDS_WORKTREE =
	"The main checkout stays untouched. Call the worktree tool first (action create with a short kebab-case name, or enter with an existing branch); paths and git commands then resolve in that worktree.";

export default function (pi: ExtensionAPI) {
	let sessionCwd = process.cwd();
	let repo: Repo | undefined;
	// Only a repository with commits at session start requires a worktree; one made during the session does not.
	let guarded = false;
	let worktree: Worktree | undefined;
	let request = "";

	const cwd = (dir?: string) => {
		const base = worktree?.path ?? sessionCwd;
		return dir ? resolve(base, String(dir)) : base;
	};
	// Built-in tools resolve relative paths against ctx.cwd, which pi cannot change mid-session.
	const inCwd = <T extends ExtensionContext>(ctx: T, dir: string): T =>
		new Proxy(ctx, {
			get(target, key) {
				if (key === "cwd") return dir;
				const value: unknown = Reflect.get(target, key, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	const remap = (path: unknown) => (typeof path === "string" && repo && worktree ? remapPath(path, repo.root, worktree.path) : path);
	/** Tools that only read; a mapped path falls back to the main checkout when the worktree has no such file. */
	const READ_ONLY = new Set(["read", "grep", "find", "ls", "read_text"]);
	const remapRead = (name: string, path: unknown) => {
		const mapped = remap(path);
		if (!READ_ONLY.has(name)) return mapped;
		const found = mapped === path || !worktree || existsSync(String(mapped)) ? mapped : path;
		return typeof found === "string" ? withNarrowSpaces(resolve(cwd(), found)) ?? found : found;
	};
	const needsWorktree = () => guarded && !worktree;
	const inMainCheckout = (path: string) => Boolean(repo && checkoutRelative(resolve(sessionCwd, path.replace(/^@/, "")), repo.root) !== undefined);

	const devshells = new Map<string, { stamp: string; pending: Promise<Devshell | undefined> }>();
	const devshellErrors = new Map<string, string>();
	const env = async (dir: string, name?: string): Promise<NodeJS.ProcessEnv> => {
		// A flake created or edited mid-session changes the stamp, so the next command gets its devshell.
		const stamp = devshellStamp(dir);
		const key = name ? `${dir}#${name}` : dir;
		let entry = devshells.get(key);
		if (entry?.stamp !== stamp) {
			devshellErrors.delete(key);
			const pending = resolveDevshell(dir, name).catch((error: Error) => {
				devshellErrors.set(key, error.message.split("\n").slice(0, 5).join("\n"));
				devshells.delete(key);
				return undefined;
			});
			entry = { stamp, pending };
			devshells.set(key, entry);
		}
		return applyEnv(process.env, await entry.pending);
	};

	const switchTo = (ctx: ExtensionContext, next: Worktree | undefined) => {
		worktree = next;
		setSessionDir(ctx, next?.path);
		pi.appendEntry(ENTRY, next ?? { main: sessionCwd });
		if (next && ctx.hasUI) ctx.ui.notify(`Worktree ${next.path} on ${next.branch}`, "info");
	};

	const override = <P extends TObject, D, S>(factory: (dir: string) => ToolDefinition<P, D, S>, options: { exposure?: "codemode" } = {}) => {
		const template = factory(sessionCwd);
		pi.registerTool({
			...template,
			exposure: options.exposure ?? template.exposure,
			async execute(id, params, signal, onUpdate, ctx) {
				const input = { ...params };
				if ("path" in input && typeof input.path === "string") Object.assign(input, { path: remapRead(template.name, input.path) });
				if ("paths" in input && Array.isArray(input.paths)) Object.assign(input, { paths: input.paths.map(remap) });
				if ("input" in input && typeof input.input === "string" && repo && worktree) {
					const { root } = repo;
					const target = worktree.path;
					Object.assign(input, { input: input.input.replace(/\[([^\]#\n]+)#/g, (_m, path: string) => `[${remapPath(path, root, target)}#`) });
				}
				const dir = cwd();
				const result = await factory(dir).execute(id, input, signal, onUpdate, inCwd(ctx, dir));
				// Hooks such as pi-lsp's and pi-lens's read the path a tool reports through its call input,
				// and resolve a relative one against the main checkout.
				if ("path" in input && typeof input.path === "string")
					Object.assign(params, { path: worktree ? resolve(dir, input.path) : input.path });
				return result;
			},
		});
	};

	const store = new EditStore();
	const hashline = hashlineTools(store);
	override(hashline.read);
	override(hashline.edit);
	override(hashline.replace);
	override(hashline.write);
	override(
		substituteTool(store, (absolute, input) => {
			if (needsWorktree() && inMainCheckout(absolute)) return NEEDS_WORKTREE;
			// guards asks the user about restricted folders named in paths; one reached only by expanding a directory was never asked about.
			const folder = restrictedFolder(absolute, cwd());
			if (!folder || (!input.apply && readableFolder(folder)) || input.paths?.some((path) => restrictedFolder(path, cwd()) === folder)) return undefined;
			return `${folder} is restricted; name it in paths so the user is asked.`;
		}),
		{ exposure: "codemode" },
	);
	override(structuredGrep);
	override(structuredFind, { exposure: "codemode" });
	override(structuredLs, { exposure: "codemode" });
	override(readTextTool, { exposure: "codemode" });

	// pi's own bash would run commands past the guards and outside the devshell; run replaces it.
	pi.registerTool({ ...createBashToolDefinition(sessionCwd), exposure: "hidden" });
	const ssh = registerSsh(pi, () => env(cwd()), (path) => cwd(path));
	registerShell(pi, { cwd, env, devshellError: (dir, name) => devshellErrors.get(name ? `${dir}#${name}` : dir), sshCommand: ssh.command });
	registerSubagent(pi, { cwd: () => cwd(), env });
	registerInterrupt(pi);
	pi.registerTool({
		name: "sleep",
		label: "Sleep",
		description: "Wait up to 300 seconds, for polling loops in scripts, which have no timers.",
		parameters: Type.Object({ seconds: Type.Number({ description: "Seconds to wait, at most 300." }) }),
		exposure: "codemode",
		async execute(_id, input: { seconds: number }, signal) {
			const ms = Math.min(300, Math.max(0, input.seconds)) * 1000;
			await new Promise<void>((done) => {
				const timer = setTimeout(done, ms);
				signal?.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
			});
			if (signal?.aborted) throw new Error("Sleep interrupted");
			return { content: [{ type: "text", text: `Slept ${ms / 1000}s` }], details: undefined };
		},
	});

	pi.on("user_bash", async (event) => {
		const local = createLocalBashOperations();
		const dir = worktree?.path ?? event.cwd;
		const shellEnv = await env(dir);
		const operations: BashOperations = {
			exec: (command, _cwd, options) => local.exec(command, dir, { ...options, env: { ...options.env, ...shellEnv } }),
		};
		return { operations };
	});

	pi.on("session_start", async (_event, ctx) => {
		sessionCwd = ctx.cwd;
		repo = await detectRepo(ctx.cwd);
		guarded = Boolean(repo && !repo.linked && repo.hasCommits);
		const saved = ctx.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "custom" && entry.customType === ENTRY)
			.at(-1);
		const data = saved?.type === "custom" ? (saved.data as Worktree | { main?: string } | null | undefined) : undefined;
		if (data && "main" in data && typeof data.main === "string" && existsSync(data.main)) {
			sessionCwd = data.main;
			repo = (await detectRepo(data.main)) ?? repo;
			guarded = Boolean(repo && !repo.linked && repo.hasCommits);
			worktree = undefined;
			setSessionDir(ctx, data.main);
		} else {
			worktree = data && "path" in data && existsSync(data.path) ? data : undefined;
			setSessionDir(ctx, worktree?.path);
		}
	});

	pi.on("before_agent_start", (event) => {
		if (event.messageType === "user" && !request) request = slug(event.prompt);
		event.systemPromptOptions.cwd = worktree?.path ?? sessionCwd;
	});

	pi.on("session_shutdown", (_event, ctx) => setSessionDir(ctx, undefined));

	pi.on("tool_call", (event, ctx) => {
		if (worktree && !existsSync(worktree.path)) switchTo(ctx, undefined);
		const input: Record<string, unknown> = event.input;
		if (event.toolName.startsWith("lsp_")) {
			// pi-lsp resolves paths against the session cwd, which is still the main checkout.
			if (!worktree) return;
			for (const key of ["file_path", "root_path"]) {
				const value = input[key];
				if (typeof value === "string" && !value.includes("://")) input[key] = resolve(worktree.path, String(remap(value)));
			}
			return;
		}
		if (!needsWorktree()) return;
		const effect = effectsOf(event.toolName, input, cwd());
		if (effect.kind === "write" && effect.paths.some(inMainCheckout)) return { block: true, reason: NEEDS_WORKTREE };
	});

	pi.on("tool_result", async (event) => {
		if (event.toolName !== "github" || event.isError || !repo || repo.linked) return;
		// The structured result says the merge happened; the rendered JSON is prose that may be reworded.
		const pr = (event.structuredContent as { pr?: { mergedAt?: string | null } } | undefined)?.pr;
		if (pr?.mergedAt) await fastForwardMain(repo.root, await baseRef(repo.root));
	});

const worktreeParams = Type.Object({
		action: Type.Union([
			Type.Literal("create"),
			Type.Literal("enter"),
			Type.Literal("remove"),
			Type.Literal("exit"),
			Type.Literal("list"),
			Type.Literal("prune"),
			Type.Literal("carry"),
			Type.Literal("ff_main"),
		]),
		name: Type.Optional(
			Type.String({
				description: "create: short kebab-case name for the new branch and directory. enter: an existing local or origin branch. remove with repo: the branch whose worktree to delete. ff_main: the branch or commit to fast-forward the default branch to.",
			}),
		),
		paths: Type.Optional(Type.Array(Type.String(), { description: "carry: paths changed in the main checkout to move into this worktree." })),
		force: Type.Optional(Type.Boolean({ description: "remove, exit: discard uncommitted changes." })),
		repo: Type.Optional(
			Type.String({
				description:
					"Another repository's main checkout (absolute path) to run create, enter, remove, list, prune, or ff_main in. The session stays where it is; run commands in the new worktree through run's cwd.",
			}),
		),
	});
	const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: undefined });
	/** Fast-forwards the default branch to `target`, or to origin's copy of it. */
	const fastForwardDefault = async (root: string, target: string | undefined) => {
		const base = await baseRef(root);
		const main = base.replace(/^origin\//, "");
		if (main === "HEAD") throw new Error("No default branch (main or master) to fast-forward.");
		return `${await fastForwardBranch(root, main, target ?? base)} This is local; push only when the user asked.`;
	};
	/** Worktree actions in a repository other than the session's; the session's directory stays unchanged. */
	const inOtherRepo = async (root: string, input: Static<typeof worktreeParams>) => {
		const hint = "Run commands there with run's cwd and use absolute file paths; this session's directory is unchanged.";
		switch (input.action) {
			case "create":
			case "enter": {
				if (!input.name) throw new Error(`${input.action} needs a name.`);
				const made = input.action === "create" ? await createWorktree(root, input.name) : await enterWorktree(root, input.name);
				if (input.action === "create") await fastForwardMain(root, made.base);
				return text(`Worktree ${made.path} on branch ${made.branch} (from ${made.base} at ${made.commit}). ${hint}`);
			}
			case "remove": {
				if (!input.name) throw new Error("remove with repo needs the branch name of the worktree.");
				const target = (await ownWorktrees(root)).find((w) => w.branch === input.name);
				if (!target) throw new Error(`No worktree of branch ${input.name} under ${root}/.worktrees/.`);
				const refusal = await removeWorktree(root, target.path, input.force ?? false);
				if (refusal) throw new Error(refusal);
				await fastForwardMain(root, await baseRef(root));
				return text(`Removed ${target.path}; branch ${input.name} is kept.`);
			}
			case "list": {
				const rows = (await ownWorktrees(root)).map((w) => `  ${w.path} ${w.branch ?? "(detached)"}`);
				return text(rows.join("\n") || `No worktrees under ${root}/.worktrees/.`);
			}
			case "prune": {
				const base = await baseRef(root);
				const removed = await pruneWorktrees(root, base);
				await fastForwardMain(root, base);
				return text(removed.length ? `Removed:\n${removed.join("\n")}` : "Nothing merged to prune.");
			}
			case "ff_main":
				return text(await fastForwardDefault(root, input.name));
			case "exit":
				throw new Error("exit applies to this session's worktree; call it without repo.");
			case "carry":
				throw new Error("carry works only in this session's repository.");
		}
		throw new Error(`Unknown action ${String(input.action)}.`);
	};
	pi.registerTool({
		name: "worktree",
		label: "Worktree",
		description:
			"Control this session's git worktree under .worktrees/, or with repo, worktrees of another repository. create: a new branch from the default branch. enter: an existing branch, reusing its worktree. remove: delete the current worktree and keep its branch. exit: leave the current worktree, remove it, and return to the main checkout; a merged branch is deleted and an unmerged one kept. list. prune: delete clean worktrees whose work is merged, the current one and a detached one included, and their branches; call it once a branch merges. carry: move uncommitted changes to paths in the main checkout (such as a file the user edited there) into the current worktree, leaving the main checkout clean. ff_main: fast-forward the default branch to name, else this worktree's branch, else origin's default branch; anything but a fast-forward is refused, and nothing is pushed. Writes in the main checkout are blocked until create or enter.",
		promptSnippet: "Create, enter, exit, remove, list, or prune .worktrees/ worktrees; carry main-checkout changes in; fast-forward main. Create one before writing",
		parameters: worktreeParams,
		async execute(_id, input: Static<typeof worktreeParams>, _signal, _onUpdate, ctx) {
			if (!worktree && !repo?.hasCommits) repo = await detectRepo(sessionCwd);
			if (input.repo) {
				const other = await detectRepo(resolve(cwd(), input.repo.replace(/^@/, "")));
				if (!other) throw new Error(`${input.repo} is not in a git repository.`);
				if (other.root !== repo?.root) {
					if (other.linked) throw new Error(`${other.root} is a linked worktree; pass its main checkout.`);
					if (!other.hasCommits) throw new Error(`${other.root} has no commits; work in it directly.`);
					return inOtherRepo(other.root, input);
				}
			}
			if (!repo) return text("Not in a git repository; nothing to do.");
			if (repo.linked && input.action !== "exit")
				return text(`The session started in linked worktree ${repo.root}; use exit to return to ${repo.mainRoot}.`);
			if (!repo.hasCommits) return text("The repository has no commits; work in it directly.");
			const { root } = repo;
			switch (input.action) {
				case "create":
				case "enter": {
					if (!input.name) throw new Error(`${input.action} needs a name.`);
					const next = input.action === "create" ? await createWorktree(root, input.name) : await enterWorktree(root, input.name);
					switchTo(ctx, next);
					if (input.action === "create") await fastForwardMain(root, next.base);
					return text(`Now in worktree ${next.path} on branch ${next.branch} (from ${next.base} at ${next.commit}). All paths resolve there; the main checkout stays untouched.`);
				}
				case "remove": {
					if (!worktree) return text("No current worktree to remove.");
					const refusal = await removeWorktree(root, worktree.path, input.force ?? false);
					if (refusal) throw new Error(refusal);
					const gone = worktree;
					switchTo(ctx, undefined);
					await fastForwardMain(root, await baseRef(root));
					return text(`Removed ${gone.path}; branch ${gone.branch} is kept.${guarded ? " Create or enter a worktree before the next write." : ""}`);
				}
				case "exit": {
					const mainRoot = repo.linked ? repo.mainRoot : root;
					const path = worktree?.path ?? repo.root;
					const listed = await ownWorktrees(mainRoot);
					const target = listed.find((w) => w.path === path) ?? (worktree?.path === path ? worktree : undefined);
					if (!target) return text("No current worktree to exit.");
					const refusal = await removeWorktree(mainRoot, target.path, input.force ?? false);
					if (refusal) throw new Error(refusal);
					sessionCwd = mainRoot;
					const previous = repo;
					repo = (await detectRepo(mainRoot)) ?? repo;
					switchTo(ctx, undefined);
					// The session directory is the main checkout now, even when the session started in the worktree.
					setSessionDir(ctx, mainRoot);
					if (previous.linked) guarded = Boolean(repo && repo.hasCommits);
					const base = await baseRef(mainRoot);
					let branch = target.branch ? `; branch ${target.branch} kept` : "";
					if (target.branch && (await mergedBranch(mainRoot, base, target.branch))) {
						const deleted = await deleteBranch(mainRoot, target.branch);
						branch = deleted ? `; branch ${target.branch} deleted (merged)` : `; branch ${target.branch} kept`;
					}
					await fastForwardMain(mainRoot, base);
					return text(`Left ${target.path}; now in ${mainRoot}${branch}.${guarded ? " Create or enter a worktree before the next write." : ""}`);
				}
				case "list": {
					const rows = (await ownWorktrees(root)).map((w) => `${w.path === worktree?.path ? "* " : "  "}${w.path} ${w.branch ?? "(detached)"}`);
					return text(rows.join("\n") || "No worktrees under .worktrees/.");
				}
				case "prune": {
					const base = await baseRef(root);
					const removed = await pruneWorktrees(root, base);
					if (worktree && !existsSync(worktree.path)) switchTo(ctx, undefined);
					await fastForwardMain(root, base);
					return text(removed.length ? `Removed:\n${removed.join("\n")}` : "Nothing merged to prune.");
				}
				case "carry": {
					if (!worktree) throw new Error("Create or enter a worktree first.");
					if (!input.paths?.length) throw new Error("carry needs paths.");
					const status = await carryChanges(root, worktree.path, input.paths.map((p) => p.replace(/^@/, "")));
					return text(`Moved into ${worktree.path}:\n${status}`);
				}
				case "ff_main":
					return text(await fastForwardDefault(root, input.name ?? worktree?.branch));
			}
			throw new Error(`Unknown action ${String(input.action)}.`);
		},
	});

	pi.registerCommand("worktree", {
		description: "Create the session's git worktree: /worktree <name>",
		handler: async (args, ctx) => {
			if (worktree) return ctx.ui.notify(`Already in ${worktree.path}`, "info");
			if (!repo?.hasCommits) repo = await detectRepo(sessionCwd);
			if (!repo || repo.linked || !repo.hasCommits) return ctx.ui.notify("No worktree needed here", "info");
			switchTo(ctx, await createWorktree(repo.root, args.trim() || request || "work"));
		},
	});
}
