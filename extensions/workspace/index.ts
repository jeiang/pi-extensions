import {
	type BashOperations,
	createBashToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLocalBashOperations,
	createLsToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { EditStore } from "@oh-my-pi/pi-natives";
import { resolve } from "node:path";
import { type Static, type TObject, Type } from "typebox";
import { applyEnv, type Devshell, resolveDevshell } from "./devshell.ts";
import { hashlineTools } from "./hashline.ts";
import { registerShell } from "./shell.ts";
import { createWorktree, detectRepo, GIT_MUTATION, type Repo, remapPath, slug } from "./worktree.ts";

export default function (pi: ExtensionAPI) {
	let sessionCwd = process.cwd();
	let repo: Repo | undefined;
	let worktree: { path: string; branch: string; base: string } | undefined;
	let creating: Promise<string> | undefined;
	let request = "";

	const cwd = () => worktree?.path ?? sessionCwd;
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
	const needsWorktree = () => Boolean(repo && !repo.linked && repo.hasCommits && !worktree);

	const devshells = new Map<string, Promise<Devshell | undefined>>();
	const devshellErrors = new Map<string, string>();
	const env = async (dir: string): Promise<NodeJS.ProcessEnv> => {
		let pending = devshells.get(dir);
		if (!pending) {
			pending = resolveDevshell(dir).catch((error: Error) => {
				devshellErrors.set(dir, error.message.split("\n").slice(0, 5).join("\n"));
				devshells.delete(dir);
				return undefined;
			});
			devshells.set(dir, pending);
		}
		return applyEnv(process.env, await pending);
	};

	const ensureWorktree = async (ctx: ExtensionContext, name?: string): Promise<string | undefined> => {
		if (!needsWorktree() || !repo) return undefined;
		creating ??= createWorktree(repo.root, name ?? (request || "work")).then((created) => {
			worktree = created;
			if (ctx.hasUI) ctx.ui.notify(`Worktree ${created.path} on ${created.branch} from ${created.base}`, "info");
			return `Created worktree ${created.path} on branch ${created.branch} from ${created.base}. All paths now resolve there; the main checkout stays untouched.`;
		});
		try {
			return await creating;
		} finally {
			creating = undefined;
		}
	};

	const override = <P extends TObject, D, S>(
		factory: (dir: string) => ToolDefinition<P, D, S>,
		options: { exposure?: "codemode"; mutates?: boolean } = {},
	) => {
		const template = factory(sessionCwd);
		pi.registerTool({
			...template,
			exposure: options.exposure ?? template.exposure,
			async execute(id, params, signal, onUpdate, ctx) {
				const note = options.mutates ? await ensureWorktree(ctx) : undefined;
				const input = { ...params };
				if ("path" in input && typeof input.path === "string") Object.assign(input, { path: remap(input.path) });
				if ("input" in input && typeof input.input === "string" && repo && worktree) {
					const { root } = repo;
					const target = worktree.path;
					Object.assign(input, { input: input.input.replace(/\[([^\]#\n]+)#/g, (_m, path: string) => `[${remapPath(path, root, target)}#`) });
				}
				const dir = cwd();
				const result = await factory(dir).execute(id, input, signal, onUpdate, inCwd(ctx, dir));
				// Hooks such as pi-lsp's read the path a tool reports through its call input.
				if ("path" in input && !("path" in params)) Object.assign(params, { path: input.path });
				if (note) result.content = [{ type: "text", text: note }, ...result.content];
				return result;
			},
		});
	};

	const hashline = hashlineTools(new EditStore());
	override(hashline.read);
	override(hashline.edit, { mutates: true });
	override(hashline.write, { mutates: true });
	override((dir) => createGrepToolDefinition(dir), { exposure: "codemode" });
	override((dir) => createFindToolDefinition(dir), { exposure: "codemode" });
	override((dir) => createLsToolDefinition(dir), { exposure: "codemode" });

	const bashTemplate = createBashToolDefinition(sessionCwd);
	pi.registerTool({
		...bashTemplate,
		exposure: "codemode",
		async execute(id, params, signal, onUpdate, ctx) {
			const dir = cwd();
			const shellEnv = await env(dir);
			const tool = createBashToolDefinition(dir, { spawnHook: (spawn) => ({ ...spawn, env: { ...spawn.env, ...shellEnv } }) });
			const result = await tool.execute(id, params, signal, onUpdate, inCwd(ctx, dir));
			const error = devshellErrors.get(dir);
			if (error) result.content = [{ type: "text", text: `devshell failed, ran without it:\n${error}` }, ...result.content];
			return result;
		},
	});

	registerShell(pi, { cwd, env });

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
	});

	pi.on("before_agent_start", (event) => {
		if (event.messageType === "user" && !request) request = slug(event.prompt);
		if (worktree) event.systemPromptOptions.cwd = worktree.path;
	});

	pi.on("tool_call", (event) => {
		if (event.toolName.startsWith("lsp_")) {
			// pi-lsp resolves paths against the session cwd, which is still the main checkout.
			if (!worktree) return;
			const input: Record<string, unknown> = event.input;
			for (const key of ["file_path", "root_path"]) {
				const value = input[key];
				if (typeof value === "string" && !value.includes("://")) input[key] = resolve(worktree.path, String(remap(value)));
			}
			return;
		}
		if (event.toolName !== "bash" && event.toolName !== "shell") return;
		const command = (event.input as { command?: unknown }).command;
		if (typeof command !== "string" || !needsWorktree() || !GIT_MUTATION.test(command) || /\bcd\s|\bgit\s+-C\s/.test(command)) return;
		return {
			block: true,
			reason: "The main checkout stays untouched. Call the worktree tool first; git commands then run in the new worktree.",
		};
	});

	const worktreeParams = Type.Object({
		name: Type.String({ description: "Short kebab-case branch and directory name for the change." }),
	});
	pi.registerTool({
		name: "worktree",
		label: "Worktree",
		description:
			"Create a git worktree in .worktrees/<name> on a new branch from the default branch and move this session into it. The first edit or write does this automatically; call it first to choose the name, or before shell commands that write files.",
		promptSnippet: "Create the session's git worktree (.worktrees/<name>) before changing files",
		parameters: worktreeParams,
		exposure: "model-only",
		async execute(_id, input: Static<typeof worktreeParams>, _signal, _onUpdate, ctx) {
			if (worktree) return { content: [{ type: "text", text: `Already in ${worktree.path} (${worktree.branch}).` }], details: undefined };
			if (!repo) return { content: [{ type: "text", text: "Not in a git repository; nothing to do." }], details: undefined };
			if (repo.linked) return { content: [{ type: "text", text: `Already in linked worktree ${repo.root}.` }], details: undefined };
			if (!repo.hasCommits) return { content: [{ type: "text", text: "The repository has no commits; work in it directly." }], details: undefined };
			const note = await ensureWorktree(ctx, input.name);
			return { content: [{ type: "text", text: note ?? "No worktree needed." }], details: undefined };
		},
	});

	pi.registerCommand("worktree", {
		description: "Create the session's git worktree: /worktree <name>",
		handler: async (args, ctx) => {
			const note = await ensureWorktree(ctx, args.trim() || undefined);
			ctx.ui.notify(note ?? (worktree ? `Already in ${worktree.path}` : "No worktree needed here"), "info");
		},
	});
}
