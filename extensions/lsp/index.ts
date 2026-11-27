import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { type ExtensionAPI, type ExtensionContext, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { sessionDir, sessionPath } from "../workspace/cwd.ts";
import { patchTargets } from "../workspace/hashline.ts";
import { provideSymbolLines } from "./bridge.ts";
import { type LspSettings, parseSettings, routesFor } from "./config.ts";
import { dependentErrors, type FileReport, makeService, newFindings, renderFinding, reports, type Service, visible } from "./diagnostics.ts";
import { previewPaths } from "./edits.ts";
import { stopInstances } from "./pool.ts";
import { displayPath } from "./text.ts";
import { type LspOutput, lspOutput, type LspParams, lspParams, runLsp, symbolLines } from "./tool.ts";

const ENTRY = "lsp-enablement";
/** Time a post-edit check may take before the edit, and again after it. */
const BUDGET_MS = 20_000;

interface Baseline {
	reports?: Map<string, FileReport>;
	texts: Map<string, string | undefined>;
}

/** Resolves to `work`, or undefined once `ms` pass. */
function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<undefined>((done) => {
		timer = setTimeout(() => done(undefined), Math.max(0, ms));
	});
	return Promise.race([work.catch(() => undefined), timeout]).finally(() => clearTimeout(timer));
}

export default function (pi: ExtensionAPI) {
	let settings: LspSettings = parseSettings([]);
	const sessionChoice = new Map<string, boolean>();
	const enabled = (id: string) => sessionChoice.get(id) ?? settings.enablement.get(id) ?? true;
	const serviceFor = (ctx: ExtensionContext): Service => {
		const cwd = sessionDir(ctx);
		return makeService(settings, cwd, enabled, (path) => routesFor(settings.servers.values(), path, cwd));
	};
	/** Files a substitute preview would change, by its token, so its apply can be checked against them. */
	const substitutePreviews = new Map<string, string[]>();
	const baselines = new Map<string, Promise<Baseline>>();

	pi.on("session_start", (_event, ctx) => {
		const manager = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
		const lspOf = (document: unknown) => (document as { lsp?: unknown } | undefined)?.lsp;
		settings = parseSettings([
			{ scope: "global", lsp: lspOf(manager.getGlobalSettings()) },
			{ scope: "project", lsp: lspOf(manager.getProjectSettings()) },
		]);
		if (settings.warnings.length && ctx.hasUI) ctx.ui.notify(`LSP settings:\n- ${settings.warnings.join("\n- ")}`, "warning");
		sessionChoice.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY) continue;
			const data = entry.data as { server?: string; enabled?: boolean } | undefined;
			if (data?.server && typeof data.enabled === "boolean") sessionChoice.set(data.server, data.enabled);
		}
	});

	provideSymbolLines((ctx, absolute, symbol) => symbolLines(serviceFor(ctx), absolute, symbol));

	pi.registerTool({
		name: "lsp",
		label: "LSP",
		description:
			"Language-server navigation, diagnostics, and refactors. A position is path + line + character (1-based columns in characters), path + line + symbol (a name on that line, foo#2 for its second occurrence), or path + symbol (a declaration by name, Class.method). Locations come back as path:line:col and the source line. rename, rename_file (moves a file and updates the imports that name it), and code_actions preview first, writing nothing; call again with apply: true and the token, which refuses if a file changed since. Servers come from settings.json lsp.servers and start on first use.",
		promptSnippet: "Definitions, references, hover, symbols, call hierarchy, diagnostics; rename, move files, code actions with preview and token",
		parameters: lspParams,
		outputSchema: lspOutput,
		async execute(_id, input: LspParams, _signal, _onUpdate, ctx) {
			const output: LspOutput = await runLsp(serviceFor(ctx), input, (path) => sessionPath(ctx, path));
			return { content: [{ type: "text", text: output.text }], details: undefined, structuredContent: output };
		},
	});

	/** The files a call writes, absolute, or none when it writes nothing a server could check. */
	const targetsOf = (toolName: string, input: Record<string, unknown>, ctx: ExtensionContext): string[] => {
		const dir = sessionDir(ctx);
		switch (toolName) {
			case "write":
			case "replace":
				return typeof input.path === "string" ? [sessionPath(ctx, input.path)] : [];
			case "edit":
				return typeof input.input === "string"
					? patchTargets(dir, "hashline", input).map((path) => sessionPath(ctx, path))
					: typeof input.path === "string"
						? [sessionPath(ctx, input.path)]
						: [];
			case "substitute":
				return input.apply && typeof input.token === "string" ? (substitutePreviews.get(input.token) ?? []) : [];
			case "lsp":
				return input.apply && typeof input.token === "string" ? (previewPaths(input.token) ?? []) : [];
		}
		return [];
	};
	const checked = (service: Service, paths: string[]) => [...new Set(paths)].filter((path) => service.routes(path).length > 0 || settings.astGrep);

	// Pull the findings the files have before the call, so the result lists only the ones it introduced; it never blocks the call.
	pi.on("tool_call", async (event, ctx) => {
		const service = serviceFor(ctx);
		const paths = checked(service, targetsOf(event.toolName, event.input as Record<string, unknown>, ctx));
		if (paths.length === 0) return;
		const work = (async (): Promise<Baseline> => {
			const texts = new Map<string, string | undefined>();
			for (const path of paths) texts.set(path, await readFile(path, "utf8").catch(() => undefined));
			const existing = paths.filter((path) => texts.get(path) !== undefined);
			return { texts, reports: await within(reports(service, existing), BUDGET_MS) };
		})();
		baselines.set(event.toolCallId, work);
		await work;
	});

	pi.on("tool_result", async (event, ctx) => {
		const input = event.input as Record<string, unknown>;
		if (event.toolName === "substitute" && !input.apply && !event.isError) {
			const structured = event.structuredContent as { token?: string; files?: { path: string }[] } | undefined;
			if (structured?.token) substitutePreviews.set(structured.token, (structured.files ?? []).map((file) => sessionPath(ctx, file.path)));
			return;
		}
		const pending = baselines.get(event.toolCallId);
		if (!pending) return;
		baselines.delete(event.toolCallId);
		const baseline = await pending;
		if (event.isError) return;
		const service = serviceFor(ctx);
		const deadline = Date.now() + BUDGET_MS;
		const paths = [...baseline.texts.keys()].filter((path) => existsSync(path));
		const after = await within(reports(service, paths), BUDGET_MS);
		if (!after) return;
		const rows: string[] = [];
		const notes: string[] = [];
		let unchanged = 0;
		let covered = 0;
		for (const report of after.values()) {
			if (report.outcomes.length === 0) continue;
			covered++;
			report.findings = report.findings.filter((finding) => visible(settings, finding.diagnostic));
			const before = baseline.reports?.get(report.path);
			const diff = newFindings(before && { ...before, findings: before.findings.filter((f) => visible(settings, f.diagnostic)) }, report);
			unchanged += diff.unchanged;
			for (const finding of diff.added) rows.push(renderFinding(finding, report, service.cwd));
			for (const outcome of report.outcomes)
				if (outcome.status !== "fresh") notes.push(`${outcome.server} ${outcome.status === "timeout" ? "timed out on" : `unavailable for`} ${displayPath(report.path, service.cwd)}${outcome.detail ? `: ${outcome.detail}` : ""}`);
		}
		if (covered === 0) return;
		const dependents: string[] = [];
		for (const path of paths) {
			const before = baseline.texts.get(path);
			const now = after.get(path)?.text;
			if (before === undefined || now === undefined || Date.now() > deadline) continue;
			const found = await within(dependentErrors(service, path, before, now, deadline), deadline - Date.now());
			if (found) dependents.push(...found.lines);
		}
		const noBaseline = baseline.reports ? "" : " (no baseline in time; all shown)";
		const head = rows.length
			? `LSP: ${rows.length} new finding(s)${noBaseline}${unchanged ? `; ${unchanged} unchanged` : ""}:`
			: `LSP: no new errors or warnings${unchanged ? `; ${unchanged} unchanged` : ""}.`;
		const section = [head, ...rows, ...(dependents.length ? ["New errors in dependent files:", ...dependents] : []), ...notes].join("\n");
		const structured = event.structuredContent;
		return {
			content: [...event.content, { type: "text" as const, text: `\n${section}` }],
			...(structured && typeof structured === "object" && !Array.isArray(structured) ? { structuredContent: { ...structured, diagnostics: section } } : {}),
		};
	});

	pi.registerCommand("lsp", {
		description: "Language servers: /lsp [status | stop [server] | restart [server] | enable <server> | disable <server>]",
		handler: async (args, ctx) => {
			const [action = "status", server] = args.trim().split(/\s+/).filter(Boolean);
			const say = (text: string) => ctx.ui.notify(text, "info");
			switch (action) {
				case "status":
					return say((await runLsp(serviceFor(ctx), { op: "status" }, (p) => sessionPath(ctx, p))).text);
				case "stop":
				case "restart": {
					const count = await stopInstances(server);
					return say(`Stopped ${count} server instance(s)${action === "restart" ? "; each starts again on its next file" : ""}.`);
				}
				case "enable":
				case "disable": {
					if (!server || !settings.servers.has(server)) return say(`Name a configured server: ${[...settings.servers.keys()].join(", ")}`);
					sessionChoice.set(server, action === "enable");
					pi.appendEntry(ENTRY, { server, enabled: action === "enable" });
					if (action === "disable") await stopInstances(server);
					return say(`${server} ${action}d for this session.`);
				}
			}
			return say("Usage: /lsp [status | stop [server] | restart [server] | enable <server> | disable <server>]");
		},
	});
}
