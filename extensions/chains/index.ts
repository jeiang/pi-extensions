import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";

export const CHAIN_PROVIDER = "chain";

export interface ChainConfig {
	name?: string;
	/** Context tokens at which the extension compacts a session on this chain. */
	compactAt?: number;
	/** `provider/model` with an optional `:level` suffix, in fallback order. */
	targets: string[];
}

export interface ChainsConfig {
	chains: Record<string, ChainConfig>;
	cooldownFile?: string;
	/** Milliseconds a provider is skipped after a retryable failure (overload, 429, 5xx). */
	retryCooldownMs?: number;
	/** Milliseconds a provider is skipped after a subscription usage limit. */
	usageCooldownMs?: number;
}

interface Target {
	provider: string;
	id: string;
	thinkingLevel: ModelThinkingLevel;
}

const LEVELS: Record<string, true> = { off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true };
// Errors pi does not retry because waiting will not help: subscription and account limits.
const USAGE_LIMIT = /usage limit|quota|billing|out of budget|available balance|credit balance/i;
const OVERFLOW = /context|too long|too many tokens|maximum.*tokens/i;
const FALLBACK_NOTE = "The previous model hit its usage limit. Continue the task from where it stopped.";

export function parseTarget(spec: string): Target {
	const slash = spec.indexOf("/");
	if (slash <= 0) throw new Error(`chain target "${spec}" is not provider/model`);
	const colon = spec.lastIndexOf(":");
	const level = colon > slash ? spec.slice(colon + 1) : "";
	const hasLevel = Object.hasOwn(LEVELS, level);
	return {
		provider: spec.slice(0, slash),
		id: spec.slice(slash + 1, hasLevel ? colon : undefined),
		thinkingLevel: (hasLevel ? level : "medium") as ModelThinkingLevel,
	};
}

type Cooldowns = Record<string, number>;

function readCooldowns(file: string): Cooldowns {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!parsed || typeof parsed !== "object") return {};
		return Object.fromEntries(
			Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
		);
	} catch {
		return {};
	}
}

function writeCooldowns(file: string, cooldowns: Cooldowns) {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(cooldowns));
	renameSync(tmp, file);
}

export function createChains(config: ChainsConfig) {
	const cooldownFile = config.cooldownFile ?? join(getAgentDir(), "chains-cooldown.json");
	const retryCooldownMs = config.retryCooldownMs ?? 60_000;
	const usageCooldownMs = config.usageCooldownMs ?? 3_600_000;
	const chains = new Map(
		Object.entries(config.chains).map(([id, chain]) => [id, { ...chain, targets: chain.targets.map(parseTarget) }]),
	);

	const cool = (provider: string, ms: number) => {
		const cooldowns = readCooldowns(cooldownFile);
		cooldowns[provider] = Date.now() + ms;
		writeCooldowns(cooldownFile, cooldowns);
	};

	return (pi: ExtensionAPI) => {
		let lastError: { provider: string; message: string } | undefined;
		let fallbacks = 0;
		let compacting = false;

		const activeChain = (ctx: ExtensionContext) =>
			ctx.model?.provider === CHAIN_PROVIDER ? chains.get(ctx.model.id) : undefined;

		for (const [id, chain] of chains) {
			pi.registerVirtualModel({
				provider: CHAIN_PROVIDER,
				id,
				name: chain.name ?? `Chain ${id}`,
				route(request, ctx) {
					const now = Date.now();
					const cooldowns = readCooldowns(cooldownFile);
					if (request.reason === "retry" && request.failed) {
						const error = request.failed.message.errorMessage ?? "";
						if (!OVERFLOW.test(error)) {
							cooldowns[request.failed.model.provider] = now + retryCooldownMs;
							writeCooldowns(cooldownFile, cooldowns);
						}
					}
					const resolved = chain.targets.flatMap((target) => {
						const model = ctx.modelRegistry.find(target.provider, target.id);
						return model ? [{ target, model }] : [];
					});
					if (resolved.length === 0) throw new Error(`chain/${id}: no target model is available`);
					const isReady = (model: Model<Api>) => (cooldowns[model.provider] ?? 0) <= now;
					const sticky = request.reason === "retry" ? request.failed : request.previous;
					if (request.reason !== "user" && sticky && isReady(sticky.model)) {
						const same = resolved.find(
							({ model }) => model.provider === sticky.model.provider && model.id === sticky.model.id,
						);
						if (same) return { model: same.model, thinkingLevel: same.target.thinkingLevel };
					}
					const pick =
						resolved.find(({ model }) => isReady(model)) ??
						resolved.reduce((a, b) => ((cooldowns[a.model.provider] ?? 0) <= (cooldowns[b.model.provider] ?? 0) ? a : b));
					return { model: pick.model, thinkingLevel: pick.target.thinkingLevel };
				},
			});
		}

		pi.on("input", () => {
			fallbacks = 0;
		});

		pi.on("message_end", (event) => {
			if (event.message.role !== "assistant") return;
			lastError =
				event.message.stopReason === "error" && event.message.errorMessage
					? { provider: event.message.provider, message: event.message.errorMessage }
					: undefined;
		});

		pi.on("agent_before_settle", (event, ctx) => {
			const chain = activeChain(ctx);
			if (event.outcome !== "error" || !chain || !lastError || !USAGE_LIMIT.test(lastError.message)) return;
			if (fallbacks >= chain.targets.length - 1) return;
			fallbacks++;
			cool(lastError.provider, usageCooldownMs);
			if (ctx.hasUI) ctx.ui.notify(`chain/${ctx.model?.id}: ${lastError.provider} usage limit, falling back`, "warning");
			lastError = undefined;
			return {
				continue: true,
				entries: [{ type: "custom_message", customType: "chain-fallback", content: FALLBACK_NOTE, display: false }],
			};
		});

		pi.on("turn_end", (_event, ctx) => {
			const compactAt = activeChain(ctx)?.compactAt;
			const tokens = ctx.getContextUsage()?.tokens;
			if (!compactAt || compacting || tokens == null || tokens <= compactAt) return;
			compacting = true;
			ctx.compact({
				onComplete: () => {
					compacting = false;
				},
				onError: (error) => {
					compacting = false;
					if (ctx.hasUI) ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
				},
			});
		});

		pi.registerCommand("chain-reset", {
			description: "Clear provider cooldowns of the fallback chains",
			handler: async (_args, ctx) => {
				writeCooldowns(cooldownFile, {});
				ctx.ui.notify("Chain cooldowns cleared", "info");
			},
		});
	};
}

export default function (pi: ExtensionAPI) {
	const file = process.env.PI_CHAINS_CONFIG ?? join(getAgentDir(), "chains.json");
	createChains(JSON.parse(readFileSync(file, "utf8")) as ChainsConfig)(pi);
}
