import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { sessionDir } from "../workspace/cwd.ts";

const SEARCH_API = "https://search.nixos.org/backend";
// The public credentials search.nixos.org's own frontend sends.
const SEARCH_AUTH = `Basic ${btoa("aWVSALXpZv:X8gPHnzL52wFEekuxsfQ9cSh")}`;
const NIXHUB_API = "https://search.devbox.sh";
const OPTION_APPLY = await readFile(new URL("./option.nix", import.meta.url), "utf8");
const MAX_TEXT = 20_000;
/** A build log per output; the tail is what matters and the whole result stays readable. */
const LOG_TEXT = 8_000;
const MAX_SHOWN_DRVS = 300;
/** Derivations that take long to build from source; a hint beside nixpkgs' big-parallel feature. */
const HEAVY_NAME = /^(gcc|clang|llvm|rustc|ghc|linux|chromium|firefox|thunderbird|webkitgtk|qtbase|qtwebengine|electron|libreoffice|nodejs|openjdk|zulu|go|swift)(-|$)/;

const params = Type.Object({
	action: Type.Union(
		[
			Type.Literal("search"),
			Type.Literal("option"),
			Type.Literal("eval"),
			Type.Literal("drv_diff"),
			Type.Literal("dry_run"),
			Type.Literal("build"),
			Type.Literal("log"),
			Type.Literal("versions"),
			Type.Literal("cache"),
			Type.Literal("inputs"),
		Type.Literal("closure"),
		Type.Literal("derivation"),
		Type.Literal("flake_update"),
		],
	),
	query: Type.Optional(Type.String({ description: "search: words to find. versions: package name." })),
	type: Type.Optional(Type.Union([Type.Literal("packages"), Type.Literal("options")], { description: "search: packages (default) or options." })),
	channel: Type.Optional(Type.String({ description: "search: unstable (default), stable, or e.g. 25.11." })),
	host: Type.Optional(Type.String({ description: "option: a nixos or darwin configuration name." })),
	path: Type.Optional(Type.String({ description: "option: option path. inputs: path inside the input." })),
	flake: Type.Optional(Type.String({ description: "Flake directory; default the session directory." })),
	installable: Type.Optional(Type.String({ description: "eval: e.g. .#nixosConfigurations.alda.config.networking.hostName." })),
	expr: Type.Optional(Type.String({ description: "eval: expression instead of an installable (impure)." })),
	apply: Type.Optional(Type.String({ description: "eval: function applied to the value." })),
	outputs: Type.Optional(
		Type.Array(Type.String(), {
			description: "drv_diff, dry_run, build, log, cache: host names (system toplevel), .#attr, installables, or (cache, log) store paths.",
		}),
	),
	base: Type.Optional(Type.String({ description: "drv_diff: git revision to compare against; default HEAD." })),
	version: Type.Optional(Type.String({ description: "versions: only this version." })),
	stores: Type.Optional(Type.Array(Type.String(), { description: "cache: substituter URLs; default the configured ones." })),
	store: Type.Optional(Type.String({ description: "dry_run, build: build against this store (`ssh-ng://host`) with local evaluation. log: read the log from it." })),
	input: Type.Optional(Type.String({ description: "inputs: input to list or read; omit for all. flake_update: the input to update; omit for all." })),
	filter: Type.Optional(Type.String({ description: "closure: keep only store paths whose name matches this regex." })),
	against: Type.Optional(Type.String({ description: "closure: a second output; returns what changed from it to outputs[0] (nix store diff-closures)." })),
	why: Type.Optional(Type.String({ description: "closure: a store path or name in the closure; returns why outputs[0] depends on it (nix why-depends)." })),
	limit: Type.Optional(Type.Number({ description: "search, versions: most results (default 10)." })),
});
type Params = Static<typeof params>;

const outputSchema = Type.Object({
	action: Type.String(),
	items: Type.Optional(
		Type.Array(Type.Object({ name: Type.String(), version: Type.Optional(Type.String()), type: Type.Optional(Type.String()), description: Type.String() })),
	),
	channel: Type.Optional(Type.String()),
	option: Type.Optional(
		Type.Object({
			type: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			default: Type.Optional(Type.Unknown()),
			description: Type.Optional(Type.Union([Type.String(), Type.Null()])),
			declarations: Type.Optional(Type.Array(Type.String())),
			value: Type.Optional(Type.Unknown()),
			children: Type.Optional(Type.Array(Type.String())),
		}),
	),
	value: Type.Optional(Type.Unknown()),
	diffs: Type.Optional(
		Type.Array(
			Type.Object({
				output: Type.String(),
				before: Type.Optional(Type.String()),
				after: Type.Optional(Type.String()),
				same: Type.Optional(Type.Boolean()),
				error: Type.Optional(Type.String()),
			}),
		),
	),
	build: Type.Optional(Type.Array(Type.String({ description: "Not in any configured cache." }))),
	fetch: Type.Optional(Type.Array(Type.String())),
	download_mib: Type.Optional(Type.Number()),
	unpacked_mib: Type.Optional(Type.Number()),
	heavy: Type.Optional(Type.Array(Type.String({ description: "Likely heavy builds (big-parallel or compiler/kernel/browser names); a hint." }))),
	built: Type.Optional(Type.Array(Type.Object({ output: Type.String(), drv: Type.String(), paths: Type.Array(Type.String()) }))),
	logs: Type.Optional(
		Type.Array(Type.Object({ output: Type.String(), text: Type.Optional(Type.String()), note: Type.Optional(Type.String()), error: Type.Optional(Type.String()) })),
	),
	errors: Type.Optional(Type.Array(Type.Object({ output: Type.String(), error: Type.String() }))),
	versions: Type.Optional(
		Type.Array(Type.Object({ version: Type.String(), commit: Type.String(), date: Type.String(), platforms: Type.Array(Type.String()), attr_paths: Type.Array(Type.String()) })),
	),
	paths: Type.Optional(Type.Array(Type.Object({ store: Type.String(), path: Type.String(), status: Type.String({ description: "cached, missing, or unknown" }), note: Type.Optional(Type.String()) }))),
	inputs: Type.Optional(Type.Array(Type.Object({ name: Type.String(), path: Type.String() }))),
	entries: Type.Optional(Type.Array(Type.String())),
	closure: Type.Optional(
		Type.Object({
			root: Type.String(),
			total_mib: Type.Number({ description: "Closure size." }),
			count: Type.Number({ description: "Store paths in the closure." }),
			paths: Type.Array(Type.Object({ path: Type.String(), nar_mib: Type.Number() }), { description: "Matching paths, largest first." }),
		}),
	),
	text: Type.Optional(Type.String()),
	note: Type.Optional(Type.String()),
});
type Output = Static<typeof outputSchema>;

interface Run {
	stdout: string;
	stderr: string;
	code: number;
}

function nix(args: string[], cwd: string, signal: AbortSignal | undefined): Promise<Run> {
	return new Promise((done) => {
		execFile("nix", args, { cwd, maxBuffer: 256 * 1024 * 1024, signal }, (error, stdout, stderr) => {
			const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
			done({ stdout, stderr: stderr || (error && !stdout ? error.message : ""), code });
		});
	});
}

/** The last lines of a failed command's stderr, which hold nix's error. */
const lastLines = (stderr: string, lines = 25) => stderr.trim().split("\n").slice(-lines).join("\n");
const failure = (run: Run, what: string) => new Error(`${what} failed:\n${lastLines(run.stderr)}`);
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface Resolved {
	ok: { output: string; value: string }[];
	errors: { output: string; error: string }[];
}

/** Resolve each output on its own, so one that fails does not discard the others. */
async function resolveEach(outputs: string[], resolve: (output: string) => Promise<string>): Promise<Resolved> {
	const settled = await Promise.allSettled(outputs.map(resolve));
	const resolved: Resolved = { ok: [], errors: [] };
	settled.forEach((outcome, index) => {
		const output = outputs[index]!;
		if (outcome.status === "fulfilled") resolved.ok.push({ output, value: outcome.value });
		else resolved.errors.push({ output, error: reason(outcome.reason) });
	});
	return resolved;
}

async function nixOk(args: string[], cwd: string, signal: AbortSignal | undefined): Promise<string> {
	const run = await nix(args, cwd, signal);
	if (run.code !== 0) throw failure(run, `nix ${args.slice(0, 2).join(" ")}`);
	return run.stdout;
}

const toMiB = (size: number, unit: string) => size * ({ B: 1 / 1048576, KiB: 1 / 1024, MiB: 1, GiB: 1024, TiB: 1048576 }[unit] ?? 1);

/** Reads `nix build --dry-run` output: what will be built and what will be fetched. */
export function parseDryRun(text: string) {
	const build: string[] = [];
	const fetch: string[] = [];
	let download = 0;
	let unpacked = 0;
	let into: string[] | undefined;
	for (const line of text.split("\n")) {
		if (/^(this derivation|these \d+ derivations) will be built:/.test(line)) into = build;
		else if (/^(this path|these \d+ paths) will be fetched/.test(line)) {
			into = fetch;
			const sizes = /\(([\d.]+) (\w+) download, ([\d.]+) (\w+) unpacked\)/.exec(line);
			if (sizes) {
				download = toMiB(Number(sizes[1]), sizes[2] ?? "MiB");
				unpacked = toMiB(Number(sizes[3]), sizes[4] ?? "MiB");
			}
		} else if (into && /^\s+\/nix\/store\//.test(line)) into.push(line.trim());
		else into = undefined;
	}
	return { build, fetch, download_mib: Math.round(download * 10) / 10, unpacked_mib: Math.round(unpacked * 10) / 10 };
}

const storeName = (path: string) => path.replace(/^\/nix\/store\/[a-z0-9]{32}-/, "").replace(/\.drv$/, "");

/** Builds that are likely slow: big-parallel in the derivation, or a known heavy name. */
async function heavyOf(drvs: string[], cwd: string, signal: AbortSignal | undefined): Promise<string[]> {
	const heavy = new Set(drvs.filter((drv) => HEAVY_NAME.test(storeName(drv))));
	const shown = drvs.slice(0, MAX_SHOWN_DRVS);
	if (shown.length === 0) return [];
	const run = await nix(["derivation", "show", ...shown], cwd, signal);
	if (run.code === 0) {
		const parsed = JSON.parse(run.stdout) as Record<string, unknown>;
		const all = (parsed.derivations ?? parsed) as Record<string, { env?: Record<string, string>; structuredAttrs?: { requiredSystemFeatures?: string[] } }>;
		for (const [name, drv] of Object.entries(all)) {
			const features = drv.structuredAttrs?.requiredSystemFeatures ?? drv.env?.requiredSystemFeatures?.split(" ") ?? [];
			if (features.includes("big-parallel")) heavy.add(name.startsWith("/nix/store/") ? name : `/nix/store/${name}`);
		}
	}
	return [...heavy];
}

/** `alda` → its system toplevel; `.#x` and `nixpkgs#x` stay as they are; any other installable gets `<flake>#`. */
async function installableOf(output: string, flake: string, cwd: string, signal: AbortSignal | undefined): Promise<string> {
	if (output.includes("#") || output.startsWith("/nix/store/")) return output;
	if (/^[\w-]+$/.test(output)) {
		const kind = await kindOf(output, flake, cwd, signal);
		return kind === "nixos" ? `${flake}#nixosConfigurations.${output}.config.system.build.toplevel` : `${flake}#darwinConfigurations.${output}.system`;
	}
	return `${flake}#${output}`;
}

async function kindOf(host: string, flake: string, cwd: string, signal: AbortSignal | undefined): Promise<"nixos" | "darwin"> {
	for (const kind of ["nixos", "darwin"] as const) {
		const run = await nix(["eval", "--json", `${flake}#${kind}Configurations`, "--apply", "builtins.attrNames"], cwd, signal);
		if (run.code === 0 && (JSON.parse(run.stdout) as string[]).includes(host)) return kind;
	}
	throw new Error(`No nixosConfigurations or darwinConfigurations named ${host} in ${flake}.`);
}

interface SearchHit {
	_source: Record<string, unknown>;
}

async function searchIndex(path: string, body: unknown, signal: AbortSignal | undefined): Promise<unknown> {
	const response = await fetch(`${SEARCH_API}/${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { authorization: SEARCH_AUTH, "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal,
	});
	if (!response.ok) throw new Error(`search.nixos.org answered ${response.status} for ${path}`);
	return response.json();
}

/** The newest index alias holding documents for `channel`; search.nixos.org renames them as its schema changes. */
async function channelIndex(channel: string, signal: AbortSignal | undefined): Promise<string> {
	const aliases = ((await searchIndex("_cat/aliases?format=json", undefined, signal)) as { alias: string }[])
		.map((entry) => /^latest-(\d+)-nixos-(unstable|\d+\.\d+)$/.exec(entry.alias))
		.filter((match): match is RegExpExecArray => match !== null)
		.map((match) => ({ alias: match[0], generation: Number(match[1]), channel: match[2] ?? "" }));
	const releases = [...new Set(aliases.map((a) => a.channel).filter((c) => c !== "unstable"))].sort((a, b) => Number(b) - Number(a));
	const wanted = channel === "stable" ? releases[0] : channel;
	const candidates = aliases.filter((a) => a.channel === wanted).sort((a, b) => b.generation - a.generation);
	for (const candidate of candidates) {
		const count = (await searchIndex(`${candidate.alias}/_count`, { query: { match_all: {} } }, signal)) as { count?: number };
		if ((count.count ?? 0) > 0) return candidate.alias;
	}
	throw new Error(`No search index for channel ${channel}; known: unstable, stable, ${releases.join(", ")}.`);
}

const plain = (html: unknown) =>
	String(html ?? "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();

/** The search.nixos.org frontend's query shape: weighted fields, substring fallback, exact-name boosts. */
function searchBody(words: string[], options: boolean, limit: number) {
	const main = options ? "option_name" : "package_attr_name";
	const fields = options ? ["option_name^6", "option_name.*^3.6", "option_description^1"] : ["package_attr_name^9", "package_attr_name.*^5.4", "package_programs^9", "package_pname^6", "package_description^1.3", "package_longDescription^1"];
	const joined = words.join("");
	return {
		size: limit,
		query: {
			bool: {
				filter: [{ term: { type: options ? "option" : "package" } }],
				must: [
					{
						dis_max: {
							tie_breaker: 0.7,
							queries: [
								{ multi_match: { type: "cross_fields", query: words.join(" "), analyzer: "whitespace", operator: "and", fields } },
								...[...new Set(words.flatMap((w) => [w, w.replaceAll("_", "-"), w.replaceAll("-", "_")]))].map((w) => ({ wildcard: { [main]: { value: `*${w}*`, case_insensitive: true } } })),
							],
						},
					},
				],
				should: [{ term: { [main]: { value: joined, boost: 100 } } }, { prefix: { [main]: { value: joined, boost: 20, case_insensitive: true } } }],
			},
		},
	};
}

async function search(input: Params, signal: AbortSignal | undefined): Promise<Output> {
	const words = (input.query ?? "").toLowerCase().replace(/[*?\\]/g, "").split(/\s+/).filter(Boolean);
	if (words.length === 0) throw new Error("search needs query.");
	const options = input.type === "options";
	const channel = input.channel ?? "unstable";
	const index = await channelIndex(channel, signal);
	const result = (await searchIndex(`${index}/_search`, searchBody(words, options, input.limit ?? 10), signal)) as { hits?: { hits?: SearchHit[] } };
	const items = (result.hits?.hits ?? []).map(({ _source: s }) =>
		options
			? { name: String(s.option_name), type: String(s.option_type ?? ""), description: plain(s.option_description) }
			: { name: String(s.package_attr_name), version: String(s.package_pversion ?? ""), description: plain(s.package_description) },
	);
	return { action: "search", channel: index, items };
}

async function versions(input: Params, signal: AbortSignal | undefined): Promise<Output> {
	if (!input.query) throw new Error("versions needs query (the package name).");
	const response = await fetch(`${NIXHUB_API}/v1/pkg?name=${encodeURIComponent(input.query)}`, { headers: { accept: "application/json" }, signal });
	if (response.status === 404 || response.status === 400) throw new Error(`NixHub has no package ${input.query}.`);
	if (!response.ok) throw new Error(`NixHub answered ${response.status}.`);
	const releases = (await response.json()) as { version: string; commit_hash: string; last_updated: number | string; platforms?: string[]; systems?: Record<string, { attr_paths?: string[] }> }[];
	const rows = releases
		.filter((r) => !input.version || r.version === input.version)
		.slice(0, input.limit ?? 10)
		.map((r) => ({
			version: r.version,
			commit: r.commit_hash,
			date: new Date(Number(r.last_updated) * 1000).toISOString().slice(0, 10),
			platforms: r.platforms ?? Object.keys(r.systems ?? {}),
			attr_paths: [...new Set(Object.values(r.systems ?? {}).flatMap((s) => s.attr_paths ?? []))],
		}));
	return { action: "versions", versions: rows };
}

async function option(input: Params, flake: string, cwd: string, signal: AbortSignal | undefined): Promise<Output> {
	if (!input.host || !input.path) throw new Error("option needs host and path.");
	const kind = await kindOf(input.host, flake, cwd, signal);
	const out = await nixOk(["eval", "--json", `${flake}#${kind}Configurations.${input.host}.options.${input.path}`, "--apply", OPTION_APPLY], cwd, signal);
	return { action: "option", option: JSON.parse(out) as Output["option"] };
}

async function evaluate(input: Params, cwd: string, signal: AbortSignal | undefined): Promise<Output> {
	if (!input.installable && !input.expr) throw new Error("eval needs installable or expr.");
	const target = input.expr ? ["--impure", "--expr", input.expr] : [input.installable ?? ""];
	const out = await nixOk(["eval", "--json", ...target, ...(input.apply ? ["--apply", input.apply] : [])], cwd, signal);
	return { action: "eval", value: JSON.parse(out) as unknown };
}

async function git(args: string[], cwd: string): Promise<string> {
	return new Promise((done, fail) => execFile("git", args, { cwd }, (error, stdout) => (error ? fail(error) : done(stdout.trim()))));
}

/** A flake attr name as a Nix string literal. */
const nixString = (text: string) => JSON.stringify(text);

/**
 * A Nix expression selecting each attr path's drvPath under `root`, or null when the path or its
 * drvPath is absent. `hasAttr` guards keep one missing attr from failing the whole evaluation, and
 * tryEval keeps one broken attr from discarding the rest.
 */
export function drvPathExpr(paths: string[]): string {
	const one = (path: string) => {
		const steps = path.split(".");
		const at = (count: number) => steps.slice(0, count).reduce((prefix, step) => `${prefix}.${nixString(step)}`, "root");
		if (path === "") return `${nixString(path)} = if (builtins.hasAttr "drvPath" root) then builtins.tryEval root.drvPath else null`;
		const guards = steps.map((step, index) => `builtins.hasAttr ${nixString(step)} ${at(index)}`);
		guards.push(`builtins.hasAttr "drvPath" ${at(steps.length)}`);
		return `${nixString(path)} = if (${guards.join(" && ")}) then builtins.tryEval (builtins.unsafeDiscardStringContext ${at(steps.length)}.drvPath) else null`;
	};
	return `root: { ${paths.map(one).join("; ")}; }`;
}

interface Drv {
	drvPath?: string;
	error?: string;
}

/** The error a broken attr reports, from the one evaluation that re-creates it. */
async function drvError(ref: string, attr: string, cwd: string, signal: AbortSignal | undefined): Promise<string> {
	const run = await nix(["eval", "--raw", `${ref}#${attr}.drvPath`], cwd, signal);
	return lastLines(run.stderr, 10) || "evaluation failed";
}

/**
 * Each attr's drvPath, with one `nix eval` per flake output attr. An attr the flake does not have
 * stays out of the map, so a host can be looked for under another output; `missing` reports an
 * output the flake does not evaluate at all.
 */
async function drvPaths(ref: string, attrs: string[], cwd: string, signal: AbortSignal | undefined): Promise<{ rows: Map<string, Drv>; missing?: string }> {
	const rows = new Map<string, Drv>();
	const groups = new Map<string, string[]>();
	for (const attr of attrs) {
		const group = attr.split(".")[0]!;
		const members = groups.get(group) ?? [];
		if (!members.includes(attr)) groups.set(group, [...members, attr]);
	}
	let missing: string | undefined;
	for (const [group, members] of groups) {
		const relative = members.map((attr) => attr.slice(group.length + 1));
		const run = await nix(["eval", "--json", `${ref}#${group}`, "--apply", drvPathExpr(relative)], cwd, signal);
		if (run.code !== 0) {
			missing ??= lastLines(run.stderr, 10);
			continue;
		}
		const parsed = JSON.parse(run.stdout) as Record<string, { success: boolean; value?: string } | null>;
		for (let index = 0; index < members.length; index++) {
			const attr = members[index]!;
			const row = parsed[relative[index]!];
			if (!row) continue;
			rows.set(attr, row.success && row.value ? { drvPath: row.value } : { error: await drvError(ref, attr, cwd, signal) });
		}
	}
	return { rows, missing };
}

/** Each host's system toplevel: the nixos configuration first, then the darwin one. */
async function hostDrvs(ref: string, hosts: string[], cwd: string, signal: AbortSignal | undefined): Promise<Map<string, Drv>> {
	const found = new Map<string, Drv>();
	let missing: string | undefined;
	for (const kind of ["nixos", "darwin"] as const) {
		const rest = hosts.filter((host) => !found.has(host));
		if (rest.length === 0) break;
		const attrs = rest.map((host) => `${kind}Configurations.${host}.config.system.build.toplevel`);
		const { rows, missing: groupMissing } = await drvPaths(ref, attrs, cwd, signal);
		missing ??= groupMissing;
		rest.forEach((host, index) => {
			const row = rows.get(attrs[index]!);
			if (row) found.set(host, row);
		});
	}
	const some = found.size > 0;
	for (const host of hosts) {
		if (found.has(host)) continue;
		found.set(host, { error: some || !missing ? `No nixosConfigurations or darwinConfigurations named ${host}.` : missing });
	}
	return found;
}

/** Each output's drvPath at `ref`; `.#attr` outputs keep their flake attr, host names their config. */
async function drvsAt(ref: string, outputs: string[], cwd: string, signal: AbortSignal | undefined): Promise<Map<string, Drv>> {
	const drvs = new Map<string, Drv>();
	const hosts = outputs.filter((output) => /^[\w-]+$/.test(output));
	if (hosts.length > 0) for (const [host, row] of await hostDrvs(ref, hosts, cwd, signal)) drvs.set(host, row);
	const attrs = new Map<string, string>();
	for (const output of outputs.filter((output) => !/^[\w-]+$/.test(output))) {
		const installable = await installableOf(output, ".", cwd, signal);
		if (!installable.startsWith(".#")) throw new Error(`drv_diff compares outputs of the flake; ${output} is not one.`);
		attrs.set(output, installable.slice(2));
	}
	if (attrs.size > 0) {
		const { rows, missing } = await drvPaths(ref, [...attrs.values()], cwd, signal);
		for (const [output, attr] of attrs) drvs.set(output, rows.get(attr) ?? { error: missing ?? `No ${attr} in ${ref}.` });
	}
	return drvs;
}

async function drvDiff(input: Params, flakeDir: string, signal: AbortSignal | undefined): Promise<Output> {
	if (!input.outputs?.length) throw new Error("drv_diff needs outputs.");
	const root = await git(["rev-parse", "--show-toplevel"], flakeDir);
	const rev = await git(["rev-parse", input.base ?? "HEAD"], flakeDir);
	const dir = relative(root, flakeDir);
	// shallow=1 also accepts full clones; without it a shallow clone (as CI makes) refuses to fetch.
	const baseRef = `git+file://${root}?rev=${rev}&shallow=1${dir ? `&dir=${encodeURIComponent(dir)}` : ""}`;
	const now = await drvsAt(".", input.outputs, flakeDir, signal);
	const then = await drvsAt(baseRef, input.outputs, flakeDir, signal);
	const diffs: NonNullable<Output["diffs"]> = input.outputs.map((output) => {
		const after = now.get(output);
		const before = then.get(output);
		const error = after?.error ?? before?.error;
		return {
			output,
			...(before?.drvPath ? { before: before.drvPath } : {}),
			...(after?.drvPath ? { after: after.drvPath } : {}),
			...(before?.drvPath && after?.drvPath ? { same: before.drvPath === after.drvPath } : {}),
			...(error ? { error } : {}),
		};
	});
	const untracked = (await git(["ls-files", "--others", "--exclude-standard"], flakeDir)).split("\n").filter((file) => file.endsWith(".nix"));
	return {
		action: "drv_diff",
		diffs,
		...(untracked.length ? { note: `Untracked .nix files are invisible to the flake until git add: ${untracked.join(", ")}` } : {}),
	};
}

/** `nix build --dry-run` against `store` when given; evaluation stays on the local store, which holds the flake inputs. */
export function dryRunArgs(installables: string[], store?: string): string[] {
	return ["build", "--dry-run", "--no-link", ...(store ? ["--store", store, "--eval-store", "auto"] : []), ...installables];
}

async function dryRun(input: Params, flake: string, cwd: string, signal: AbortSignal | undefined): Promise<Output> {
	if (!input.outputs?.length) throw new Error("dry_run needs outputs.");
	const { ok, errors } = await resolveEach(input.outputs, (output) => installableOf(output, flake, cwd, signal));
	if (ok.length === 0) throw new Error(`dry_run resolved no output:\n${errors.map((entry) => `${entry.output}: ${entry.error}`).join("\n")}`);
	const run = await nix(dryRunArgs(ok.map((entry) => entry.value), input.store), cwd, signal);
	if (run.code !== 0) throw failure(run, "nix build --dry-run");
	const parsed = parseDryRun(run.stderr);
	return {
		action: "dry_run",
		...parsed,
		heavy: await heavyOf(parsed.build, cwd, signal),
		note: input.store ? `Counted against ${input.store}; evaluation stayed local.` : "Counted against this machine's substituters; CI may use others.",
		...(errors.length ? { errors } : {}),
	};
}

/** `nix build` into the named store when given, with the same local evaluation as a dry run. */
export function buildArgs(installables: string[], store?: string): string[] {
	return ["build", "--no-link", "--json", ...(store ? ["--store", store, "--eval-store", "auto"] : []), ...installables];
}

async function build(input: Params, flake: string, cwd: string, signal: AbortSignal | undefined): Promise<Output> {
	if (!input.outputs?.length) throw new Error("build needs outputs.");
	const { ok, errors } = await resolveEach(input.outputs, (output) => installableOf(output, flake, cwd, signal));
	if (ok.length === 0) throw new Error(`build resolved no output:\n${errors.map((entry) => `${entry.output}: ${entry.error}`).join("\n")}`);
	const run = await nix(buildArgs(ok.map((entry) => entry.value), input.store), cwd, signal);
	if (run.code !== 0) throw failure(run, "nix build");
	const parsed = JSON.parse(run.stdout || "[]") as { drvPath?: string; outputs?: Record<string, string> }[];
	const built = ok.map(({ output }, index) => ({
		output,
		drv: parsed[index]?.drvPath ?? "",
		paths: Object.values(parsed[index]?.outputs ?? {}),
	}));
	return { action: "build", built, ...(errors.length ? { errors } : {}) };
}

async function logs(input: Params, flake: string, cwd: string, signal: AbortSignal | undefined): Promise<Output> {
	if (!input.outputs?.length) throw new Error("log needs outputs.");
	const { ok, errors } = await resolveEach(input.outputs, (output) => installableOf(output, flake, cwd, signal));
	const rows: NonNullable<Output["logs"]> = [...errors];
	for (const { output, value } of ok) {
		const run = await nix(["log", ...(input.store ? ["--store", input.store] : []), value], cwd, signal);
		if (run.code !== 0) {
			rows.push({ output, error: lastLines(run.stderr, 10) });
			continue;
		}
		const text = run.stdout.replace(/\u001b\[[0-9;]*m/g, "");
		if (!text.trim()) rows.push({ output, note: "No log: nothing was built locally." });
		else if (text.length > LOG_TEXT) rows.push({ output, text: text.slice(-LOG_TEXT), note: `Last ${LOG_TEXT} characters.` });
		else rows.push({ output, text });
	}
	return { action: "log", logs: rows };
}

async function cache(input: Params, flake: string, cwd: string, signal: AbortSignal | undefined): Promise<Output> {
	if (!input.outputs?.length) throw new Error("cache needs outputs.");
	const stores = input.stores?.length ? input.stores : (await nixOk(["config", "show", "substituters"], cwd, signal)).trim().split(/\s+/).filter(Boolean);
	const { ok, errors } = await resolveEach(input.outputs, async (output) => {
		const installable = await installableOf(output, flake, cwd, signal);
		return installable.startsWith("/nix/store/") ? installable : (await nixOk(["eval", "--raw", `${installable}.outPath`], cwd, signal)).trim();
	});
	const rows = await Promise.all(
		stores.flatMap((store) =>
			ok.map(async ({ value: path }) => {
				const run = await nix(["path-info", "--store", store, path], cwd, signal);
				if (run.code === 0) return { store, path, status: "cached" };
				if (/is not valid/.test(run.stderr)) return { store, path, status: "missing" };
				return { store, path, status: "unknown", note: run.stderr.trim().split("\n").at(-1) ?? "" };
			}),
		),
	);
	return { action: "cache", paths: rows, ...(errors.length ? { errors } : {}) };
}

async function inputs(input: Params, flakeDir: string, signal: AbortSignal | undefined): Promise<Output> {
	const expr = `let l = builtins.fromJSON (builtins.readFile ./flake.lock); in builtins.mapAttrs (n: v: if builtins.isString v then (builtins.fetchTree l.nodes.\${v}.locked).outPath else null) l.nodes.\${l.root}.inputs`;
	const all = JSON.parse(await nixOk(["eval", "--impure", "--json", "--expr", expr], flakeDir, signal)) as Record<string, string | null>;
	const list = Object.entries(all).flatMap(([name, path]) => (path ? [{ name, path }] : []));
	if (!input.input) return { action: "inputs", inputs: list, note: "Inputs that follow another input are left out." };
	const root = list.find((entry) => entry.name === input.input)?.path;
	if (!root) throw new Error(`No input ${input.input}; known: ${list.map((entry) => entry.name).join(", ")}.`);
	const target = resolve(root, input.path ?? ".");
	if (target !== root && !target.startsWith(`${root}/`)) throw new Error("path leaves the input.");
	if ((await stat(target)).isDirectory()) return { action: "inputs", entries: (await readdir(target, { withFileTypes: true })).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)) };
	return { action: "inputs", text: (await readFile(target, "utf8")).split("\n").slice(0, 2000).join("\n") };
}

/** One output's store path: a store path as is, else the installable's out path, built if need be. */
async function storePathOf(output: string, flake: string, cwd: string, signal: AbortSignal | undefined): Promise<string> {
	const installable = await installableOf(output, flake, cwd, signal);
	if (installable.startsWith("/nix/store/")) return installable;
	const built = JSON.parse(await nixOk(buildArgs([installable]), cwd, signal)) as { outputs?: Record<string, string> }[];
	const path = Object.values(built[0]?.outputs ?? {})[0];
	if (!path) throw new Error(`nix build ${installable} returned no out path.`);
	return path;
}

async function closure(input: Params, flake: string, cwd: string, signal: AbortSignal | undefined): Promise<Output> {
	const output = input.outputs?.[0];
	if (!output) throw new Error("closure needs outputs (one).");
	const root = await storePathOf(output, flake, cwd, signal);
	if (input.against) {
		const before = await storePathOf(input.against, flake, cwd, signal);
		const text = (await nixOk(["store", "diff-closures", before, root], cwd, signal)).replace(/\u001b\[[0-9;]*m/g, "");
		return { action: "closure", text: text.trim() || "No differences." };
	}
	if (input.why) {
		const run = await nix(["why-depends", "--all", root, input.why], cwd, signal);
		const target = run.code === 0 ? input.why : undefined;
		if (target) return { action: "closure", text: run.stdout.replace(/\u001b\[[0-9;]*m/g, "").trim() };
		// A name, not a path: find it in the closure first.
		const list = JSON.parse(await nixOk(["path-info", "--recursive", "--json", root], cwd, signal)) as Record<string, unknown> | { path: string }[];
		const paths = Array.isArray(list) ? list.map((entry) => entry.path) : Object.keys(list);
		const found = paths.find((path) => storeName(path) === input.why) ?? paths.find((path) => storeName(path).includes(input.why ?? ""));
		if (!found) throw new Error(`${input.why} is not in the closure of ${root}.`);
		return { action: "closure", text: (await nixOk(["why-depends", "--all", root, found], cwd, signal)).replace(/\u001b\[[0-9;]*m/g, "").trim() };
	}
	const raw = JSON.parse(await nixOk(["path-info", "--recursive", "--json", "--closure-size", root], cwd, signal)) as
		| Record<string, { narSize?: number; closureSize?: number } | null>
		| { path: string; narSize?: number; closureSize?: number }[];
	const entries = Array.isArray(raw) ? raw.map((entry) => [entry.path, entry] as const) : Object.entries(raw).map(([path, info]) => [path, info ?? {}] as const);
	const mib = (bytes = 0) => Math.round((bytes / 1048576) * 10) / 10;
	const pattern = input.filter ? new RegExp(input.filter) : undefined;
	const paths = entries
		.filter(([path]) => !pattern || pattern.test(storeName(path)))
		.map(([path, info]) => ({ path, nar_mib: mib(info.narSize) }))
		.sort((a, b) => b.nar_mib - a.nar_mib)
		.slice(0, 500);
	const self = entries.find(([path]) => path === root)?.[1];
	return { action: "closure", closure: { root, total_mib: mib(self?.closureSize), count: entries.length, paths } };
}

async function derivation(input: Params, flake: string, cwd: string, signal: AbortSignal | undefined): Promise<Output> {
	if (!input.outputs?.length) throw new Error("derivation needs outputs.");
	const installables = await Promise.all(input.outputs.map((output) => installableOf(output, flake, cwd, signal)));
	return { action: "derivation", value: JSON.parse(await nixOk(["derivation", "show", ...installables], cwd, signal)) };
}

async function flakeUpdate(input: Params, flakeDir: string, signal: AbortSignal | undefined): Promise<Output> {
	const run = await nix(["flake", "update", ...(input.input ? [input.input] : [])], flakeDir, signal);
	if (run.code !== 0) throw failure(run, "nix flake update");
	// nix reports each changed input on stderr, from "• Updated input" on.
	const text = run.stderr.replace(/\u001b\[[0-9;]*m/g, "").trim();
	return { action: "flake_update", text: text || "No inputs changed." };
}

function render(output: Output): string {
	const text = JSON.stringify(output, null, 1);
	return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… [cut at ${MAX_TEXT} characters; a codemode script gets the whole result]` : text;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "nix",
		label: "Nix",
		description: [
			"Nix lookups, validation, and builds; structured results.",
			"search: search.nixos.org packages or options. option: type, default, declarations, and the host's value, from the flake (NixOS and nix-darwin).",
			"eval: nix eval --json. drv_diff: drvPaths vs base; same: true means nothing built changed. dry_run: what a build would fetch or build, heavy builds marked.",
			"build: nix build --no-link, returning the out paths. log: a derivation's build log, from a store path, installable, or host name.",
			"versions: NixHub history. cache: cached/missing/unknown per substituter. inputs: flake inputs; list or read inside one.",
			"closure: an output's runtime closure with sizes, filter by name; against: diff-closures from another output; why: why it depends on a path.",
			"derivation: nix derivation show. flake_update: update one input or all, writing flake.lock.",
		].join("\n"),
		promptSnippet: "Nix search, option lookup, eval, drvPath diff, dry-run, cache check, build, log, closure, flake update",
		promptGuidelines: [
			"Use the nix tool for nix eval, option lookups, drvPath diffs, dry runs, cache checks, builds, build logs, closures, derivations, and flake updates; keep nix develop and nix run in run().",
		],
		parameters: params,
		outputSchema,
		async execute(_id, input: Params, signal, _onUpdate, ctx): Promise<AgentToolResult<undefined>> {
			const cwd = sessionDir(ctx);
			const flakeDir = input.flake && !input.flake.includes(":") ? resolve(cwd, input.flake) : cwd;
			const flake = input.flake?.includes(":") ? input.flake : ".";
			const output = await (async (): Promise<Output> => {
				switch (input.action) {
					case "search":
						return search(input, signal);
					case "option":
						return option(input, flake, flakeDir, signal);
					case "eval":
						return evaluate(input, flakeDir, signal);
					case "drv_diff":
						return drvDiff(input, flakeDir, signal);
					case "dry_run":
						return dryRun(input, flake, flakeDir, signal);
					case "build":
						return build(input, flake, flakeDir, signal);
					case "log":
						return logs(input, flake, flakeDir, signal);
					case "versions":
						return versions(input, signal);
					case "cache":
						return cache(input, flake, flakeDir, signal);
					case "inputs":
						return inputs(input, flakeDir, signal);
					case "closure":
						return closure(input, flake, flakeDir, signal);
					case "derivation":
						return derivation(input, flake, flakeDir, signal);
					case "flake_update":
						return flakeUpdate(input, flakeDir, signal);
				}
				throw new Error(`Unknown action ${String(input.action)}.`);
			})();
			// SAFETY: every field is JSON from nix, NixHub, or search.nixos.org; option values and eval results are typed unknown only because they are arbitrary JSON.
			const structuredContent = output as unknown as AgentToolResult<undefined>["structuredContent"];
			return { content: [{ type: "text", text: render(output) }], details: undefined, structuredContent };
		},
	});
}
