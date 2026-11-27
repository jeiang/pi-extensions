import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** docs/tools/<tool>.md: purpose, the habits a tool replaces, examples, errors, related tools. */
const DOCS_DIR = join(import.meta.dirname, "..", "..", "docs", "tools");

export interface ToolDoc {
	name: string;
	purpose: string;
	/** "habit → tool" lines from the doc's Use instead of section. */
	habits: string[];
	body: string;
}

/** The sections of one doc; `name` is the file name without .md. */
function parseDoc(name: string, text: string): ToolDoc {
	const purpose = text.split("\n").find((line, i) => i > 0 && line.trim() && !line.startsWith("#"))?.trim() ?? "";
	const section = /## Use instead of\n([\s\S]*?)(\n## |$)/.exec(text)?.[1] ?? "";
	const habits = section
		.split("\n")
		.filter((line) => line.startsWith("- "))
		.map((line) => line.slice(2).trim());
	return { name, purpose, habits, body: text.trim() };
}

export function loadDocs(dir = DOCS_DIR): Map<string, ToolDoc> {
	const docs = new Map<string, ToolDoc>();
	if (!existsSync(dir)) return docs;
	for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
		const name = file.slice(0, -3);
		docs.set(name, parseDoc(name, readFileSync(join(dir, file), "utf8")));
	}
	return docs;
}

interface Tool {
	name: string;
	description: string;
	parameters?: unknown;
	exposure?: string;
}

const words = (text: string) => text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];

/** Tools ranked for `query` by BM25 over name, description, and the habits their docs list. */
export function rank(query: string, tools: Tool[], docs: Map<string, ToolDoc>, limit = 8): { name: string; score: number }[] {
	const corpus = tools.map((tool) => {
		const doc = docs.get(tool.name);
		return { name: tool.name, terms: words(`${tool.name} ${tool.name} ${tool.description} ${doc?.purpose ?? ""} ${doc?.habits.join(" ") ?? ""}`) };
	});
	const avg = corpus.reduce((sum, entry) => sum + entry.terms.length, 0) / Math.max(1, corpus.length);
	const frequency = new Map<string, number>();
	for (const entry of corpus) for (const term of new Set(entry.terms)) frequency.set(term, (frequency.get(term) ?? 0) + 1);
	const query_terms = [...new Set(words(query))];
	return corpus
		.map((entry) => {
			let score = 0;
			for (const term of query_terms) {
				const tf = entry.terms.filter((t) => t === term).length;
				if (tf === 0) continue;
				const idf = Math.log(1 + (corpus.length - (frequency.get(term) ?? 0) + 0.5) / ((frequency.get(term) ?? 0) + 0.5));
				score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * entry.terms.length) / avg));
			}
			return { name: entry.name, score };
		})
		.filter((entry) => entry.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit);
}

interface JsonSchema {
	type?: string;
	description?: string;
	properties?: Record<string, JsonSchema>;
	required?: string[];
	enum?: unknown[];
	anyOf?: JsonSchema[];
	const?: unknown;
	items?: JsonSchema;
}

const typeOf = (schema: JsonSchema): string => {
	const values = [...(schema.enum ?? []), ...(schema.anyOf ?? []).map((option) => option.const)].filter((value) => value !== undefined);
	if (values.length > 0) return values.map((value) => JSON.stringify(value)).join(" | ");
	if (schema.anyOf) return schema.anyOf.map(typeOf).join(" | ");
	if (schema.type === "array") return `${schema.items ? typeOf(schema.items) : "unknown"}[]`;
	return schema.type ?? "unknown";
};

/** One line per parameter, from the live schema, so the doc never drifts from the tool. */
export function renderParams(parameters: unknown): string {
	const schema = parameters as JsonSchema | undefined;
	const required = new Set(schema?.required ?? []);
	return Object.entries(schema?.properties ?? {})
		.map(([name, field]) => `- ${name}${required.has(name) ? "" : "?"}: ${typeOf(field)}${field.description ? ` — ${field.description}` : ""}`)
		.join("\n");
}

const how = (tool: Tool) =>
	tool.exposure === "codemode" ? `Scripts only: tools.${tool.name.replace(/[^\w$]/g, "_")}(args).` : `Direct, and in scripts as tools.${tool.name.replace(/[^\w$]/g, "_")}(args).`;

/** The system prompt section: each habit and the tool that replaces it. */
export function habitsSection(docs: Map<string, ToolDoc>, available: Set<string>): string {
	const lines = [...docs.values()].filter((doc) => available.has(doc.name)).flatMap((doc) => doc.habits);
	return lines.length ? `Reach for the tool instead of the habit (tool_docs { name } has the details):\n${lines.map((line) => `- ${line}`).join("\n")}` : "";
}

/** The `tool_docs` tool and the habit table in the system prompt. */
export default function (pi: ExtensionAPI) {
	const docs = loadDocs();
	const tools = () => pi.getAllTools().filter((tool) => tool.exposure !== "hidden") as Tool[];

	pi.on("before_agent_start", (event) => {
		const section = habitsSection(docs, new Set(tools().map((tool) => tool.name)));
		if (section) event.systemPromptOptions.sections = { ...event.systemPromptOptions.sections, "tool-habits": section };
	});

	pi.registerTool({
		name: "tool_docs",
		label: "Tool docs",
		description:
			"Find the tool for a job (query), or read one tool's documentation (name): how to call it, its purpose, the shell habits it replaces, every parameter, examples, and common errors. Covers script-only tools too.",
		promptSnippet: "Find the right tool, or read one tool's full documentation",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "What you want to do, or the shell command you were about to run." })),
			name: Type.Optional(Type.String({ description: "A tool name, for its full documentation." })),
			limit: Type.Optional(Type.Number({ description: "query: most results (default 8)." })),
		}),
		async execute(_id, input) {
			const all = tools();
			if (input.name) {
				const tool = all.find((candidate) => candidate.name === input.name);
				if (!tool) {
					const close = rank(input.name, all, docs, 5).map((entry) => entry.name);
					throw new Error(`No tool ${input.name}.${close.length ? ` Closest: ${close.join(", ")}.` : ""}`);
				}
				const doc = docs.get(tool.name);
				const text = [
					doc?.body ?? `# ${tool.name}\n\n${tool.description}`,
					`## How to call\n${how(tool)}`,
					`## Parameters\n${renderParams(tool.parameters) || "(none)"}`,
					doc ? `## Description\n${tool.description}` : "",
				]
					.filter(Boolean)
					.join("\n\n");
				return { content: [{ type: "text", text }], details: undefined };
			}
			if (!input.query) throw new Error("tool_docs needs query or name.");
			const ranked = rank(input.query, all, docs, input.limit ?? 8);
			const text = ranked.length
				? ranked
						.map(({ name }) => {
							const tool = all.find((candidate) => candidate.name === name);
							const summary = docs.get(name)?.purpose ?? tool?.description.split(/(?<=\.)\s/)[0] ?? "";
							return `${name}${tool?.exposure === "codemode" ? " (scripts)" : ""}: ${summary}`;
						})
						.join("\n")
				: "No tool matches; try other words, or run it with run().";
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
}
