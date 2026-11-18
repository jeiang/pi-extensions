import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type Api,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { JsonObject } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

export type Reply =
	| { text: string }
	| { tool: string; args: JsonObject }
	| { error: string };

export interface Call {
	model: string;
	lastRole: string | undefined;
}

/** Answers each request from `script`, which sees the requested `provider/model` and the transcript. */
export type Script = (model: string, context: TranscriptContext, callIndex: number) => Reply;

const ZERO_USAGE = {
	input: 100,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 110,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Scripted providers `p1`, `p2`, `p3`, each with one model `m`. */
export function scriptedProviders(script: Script, calls: Call[]): ExtensionFactory {
	return (pi) => {
		for (const provider of ["p1", "p2", "p3"]) {
			pi.registerProvider(provider, {
				baseUrl: "http://localhost",
				apiKey: "test",
				api: "scripted",
				models: [
					{
						id: "m",
						name: `${provider} m`,
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 100_000,
						maxTokens: 1000,
					},
				],
				streamSimple: (model: Model<Api>, context: TranscriptContext) => {
					const stream = createAssistantMessageEventStream();
					const name = `${model.provider}/${model.id}`;
					const last = context.messages.at(-1);
					calls.push({ model: name, lastRole: last?.role });
					const reply = script(name, context, calls.length - 1);
					const base = {
						role: "assistant" as const,
						api: model.api,
						provider: model.provider,
						model: model.id,
						usage: ZERO_USAGE,
						timestamp: Date.now(),
					};
					queueMicrotask(() => {
						if ("error" in reply) {
							const message: AssistantMessage = { ...base, content: [], stopReason: "error", errorMessage: reply.error };
							stream.push({ type: "error", reason: "error", error: message });
						} else {
							const message: AssistantMessage =
								"tool" in reply
									? {
											...base,
											content: [{ type: "toolCall", id: `call${calls.length}`, name: reply.tool, arguments: reply.args }],
											stopReason: "toolUse",
										}
									: { ...base, content: [{ type: "text", text: reply.text }], stopReason: "stop" };
							stream.push({ type: "start", partial: message });
							stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
						}
						stream.end();
					});
					return stream;
				},
			});
		}
	};
}

export async function createTestSession(options: {
	extensions: ExtensionFactory[];
	model: [string, string];
	settings?: Parameters<typeof SettingsManager.inMemory>[0];
	cwd?: string;
}): Promise<{ session: AgentSession; dir: string }> {
	const dir = mkdtempSync(join(tmpdir(), "pi-ext-test-"));
	const cwd = options.cwd ?? dir;
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
		compaction: { enabled: false },
		...options.settings,
	});
	const modelRuntime = await ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: join(dir, "models.json"),
	});
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: dir,
		settingsManager,
		extensionFactories: options.extensions,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir: dir,
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	await session.bindExtensions({});
	const model = modelRuntime.getModel(...options.model);
	if (!model) throw new Error(`model ${options.model.join("/")} not registered`);
	await session.setModel(model);
	return { session, dir };
}
