import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, matchesGlob, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { EditStore } from "@oh-my-pi/pi-natives";
import { type Static, Type } from "typebox";
import { withFileLocks } from "./mutation.ts";

const run = promisify(execFile);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SAMPLES = 3;
const MAX_LISTED = 50;

const params = Type.Object({
	pattern: Type.String({ description: "JavaScript regular expression, without slashes." }),
	replacement: Type.String({ description: "Replacement; $1, $<name>, and $& refer to the match." }),
	flags: Type.Optional(Type.String({ description: "Regex flags besides g, which is always on (i, m, s, u)." })),
	glob: Type.Optional(Type.String({ description: "Files to search, relative to the working directory, e.g. '*.ts' or 'src/**/*.nix'. A pattern without '/' matches file names at any depth." })),
	paths: Type.Optional(Type.Array(Type.String(), { description: "Files or directories to search. Named files are searched even when gitignored." })),
	include_ignored: Type.Optional(Type.Boolean({ description: "Also search gitignored files under glob and directories in paths." })),
	apply: Type.Optional(Type.Boolean({ description: "Write the changes. Needs the token from a preview with the same arguments." })),
	token: Type.Optional(Type.String({ description: "The token a preview returned." })),
});

const sample = Type.Object({ line: Type.Number(), before: Type.String(), after: Type.String() });
const outputSchema = Type.Object({
	applied: Type.Boolean(),
	token: Type.String(),
	total: Type.Number(),
	searched: Type.Number(),
	files: Type.Array(Type.Object({ path: Type.String(), count: Type.Number(), samples: Type.Array(sample) })),
	note: Type.Optional(Type.String()),
	diagnostics: Type.Optional(Type.String({ description: "After apply: new language-server findings in the changed files." })),
});
type Output = Static<typeof outputSchema>;
type Params = Static<typeof params>;

async function inGitRepo(dir: string): Promise<boolean> {
	return run("git", ["rev-parse", "--is-inside-work-tree"], { cwd: dir }).then(
		() => true,
		() => false,
	);
}

/** Every file under `dir`, skipping .git; with `ignored` false and a git repo, only tracked and unignored files. */
async function filesUnder(dir: string, ignored: boolean): Promise<string[]> {
	if (!ignored && (await inGitRepo(dir))) {
		const { stdout } = await run("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
		return stdout
			.split("\0")
			.filter(Boolean)
			.map((file) => join(dir, file));
	}
	const entries = await readdir(dir, { recursive: true, withFileTypes: true });
	return entries
		.filter((entry) => entry.isFile() && !relative(dir, join(entry.parentPath, entry.name)).split("/").includes(".git"))
		.map((entry) => join(entry.parentPath, entry.name));
}

const globMatches = (cwd: string, file: string, glob: string) =>
	glob.includes("/") ? matchesGlob(relative(cwd, file), glob) : matchesGlob(basename(file), glob);

async function candidates(cwd: string, input: Params): Promise<string[]> {
	const ignored = input.include_ignored ?? false;
	const found = new Set<string>();
	if (input.paths?.length) {
		for (const path of input.paths) {
			const absolute = resolve(cwd, path.replace(/^@/, ""));
			const info = await stat(absolute);
			if (info.isFile()) found.add(absolute);
			else for (const file of await filesUnder(absolute, ignored)) if (!input.glob || globMatches(cwd, file, input.glob)) found.add(file);
		}
	} else if (input.glob) {
		for (const file of await filesUnder(cwd, ignored)) if (globMatches(cwd, file, input.glob)) found.add(file);
	} else {
		throw new Error("substitute needs glob or paths.");
	}
	return [...found].sort();
}

interface Change {
	absolute: string;
	path: string;
	before: string;
	after: string;
	count: number;
	samples: Static<typeof sample>[];
}

/** Applies the regex to every candidate in memory; nothing is written. */
async function plan(cwd: string, input: Params) {
	const flags = [...new Set(`g${input.flags ?? ""}`)].join("");
	const regex = new RegExp(input.pattern, flags);
	const files = await candidates(cwd, input);
	const changes: Change[] = [];
	const digest = createHash("sha256").update(JSON.stringify([input.pattern, input.replacement, flags]));
	let skipped = 0;
	for (const absolute of files) {
		const info = await stat(absolute).catch(() => undefined);
		if (!info?.isFile() || info.size > MAX_FILE_BYTES) {
			skipped++;
			continue;
		}
		const buffer = await readFile(absolute);
		if (buffer.subarray(0, 8192).includes(0)) {
			skipped++;
			continue;
		}
		const before = buffer.toString("utf8");
		const count = before.match(regex)?.length ?? 0;
		digest.update(`\0${absolute}\0${createHash("sha256").update(buffer).digest("hex")}`);
		if (count === 0) continue;
		const after = before.replace(regex, input.replacement);
		const oldLines = before.split("\n");
		const newLines = after.split("\n");
		const samples: Static<typeof sample>[] = [];
		// Line-aligned samples hold when the replacement keeps the line count; otherwise the first changed lines are shown.
		for (let i = 0; i < Math.max(oldLines.length, newLines.length) && samples.length < MAX_SAMPLES; i++) {
			if (oldLines[i] !== newLines[i]) samples.push({ line: i + 1, before: oldLines[i] ?? "", after: newLines[i] ?? "" });
		}
		const rel = relative(cwd, absolute);
		changes.push({ absolute, path: rel.startsWith("..") || isAbsolute(rel) ? absolute : rel, before, after, count, samples });
	}
	return { changes, searched: files.length - skipped, skipped, token: digest.digest("hex").slice(0, 12) };
}

function render(output: Output): string {
	const head = output.applied
		? `Replaced ${output.total} match(es) in ${output.files.length} file(s).`
		: `Preview: ${output.total} match(es) in ${output.files.length} of ${output.searched} searched file(s). Nothing written; call again with apply: true and token "${output.token}".`;
	const rows = output.files.slice(0, MAX_LISTED).flatMap((file) => [
		`${file.path}: ${file.count}`,
		...file.samples.map((s) => `  ${s.line}- ${s.before}\n  ${s.line}+ ${s.after}`),
	]);
	const more = output.files.length > MAX_LISTED ? [`… ${output.files.length - MAX_LISTED} more file(s)`] : [];
	return [head, ...rows, ...more, ...(output.note ? [output.note] : [])].join("\n");
}

/** `refuse` names why a file must not be written (such as the main checkout before a worktree exists), checked on every file a run would change. */
export function substituteTool(store: EditStore, refuse: (absolute: string, input: Params) => string | undefined = () => undefined) {
	return (cwd: string): ToolDefinition<typeof params, undefined> => ({
		name: "substitute",
		label: "Substitute",
		description:
			"Regex replace across files (instead of sed -i or grep -l | xargs sed). Without apply it previews: per-file counts, sample lines, and a token, writing nothing. Call again with the same arguments, apply: true, and the token to write; it refuses if any searched file changed since the preview. glob respects .gitignore; files named in paths are always searched.",
		promptSnippet: "Regex replace across files: preview, then apply with the token",
		parameters: params,
		outputSchema,
		async execute(_id, input) {
			const { changes, searched, skipped, token } = await plan(cwd, input);
			const notes = [
				skipped ? `${skipped} binary or oversized file(s) skipped.` : "",
				input.glob && !input.include_ignored && !input.paths?.length ? "Gitignored files were not searched; name them in paths or pass include_ignored." : "",
			].filter(Boolean);
			const output: Output = {
				applied: false,
				token,
				total: changes.reduce((sum, change) => sum + change.count, 0),
				searched,
				files: changes.map(({ path, count, samples }) => ({ path, count, samples })),
				...(notes.length ? { note: notes.join(" ") } : {}),
			};
			if (input.apply) {
				if (input.token !== token) throw new Error("The token does not match: the arguments differ from the preview or a searched file changed since. Preview again.");
				for (const change of changes) {
					const reason = refuse(change.absolute, input);
					if (reason) throw new Error(`${change.path}: ${reason}`);
				}
				// The lock covers the freshness check and the write, so a concurrent edit of these files is caught or ordered, never lost.
				await withFileLocks(
					changes.map((change) => change.absolute),
					async () => {
						for (const change of changes) {
							const now = await readFile(change.absolute, "utf8").catch(() => "");
							if (now !== change.before) throw new Error(`${change.path} changed since the preview; preview again.`);
						}
						for (const change of changes) {
							await writeFile(change.absolute, change.after);
							store.recordSnapshot(change.absolute, change.after.replace(/\r\n?/g, "\n"), []);
						}
					},
				);
				output.applied = true;
			}
			return { content: [{ type: "text", text: render(output) }], details: undefined, structuredContent: output };
		},
	});
}
