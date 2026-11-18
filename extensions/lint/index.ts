import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface Rule {
	pattern: RegExp;
	message: string;
}

const COMMENT = String.raw`(?://|#|--|/\*|^\s*\*|<!--|;)`;

export const RULES: Rule[] = [
	{
		pattern: new RegExp(
			`${COMMENT}.*\\b(previously|no longer|formerly|was (re)?(worked|written|changed|moved|renamed|replaced)|migrated from|instead of the old|now uses)\\b`,
			"i",
		),
		message: "history comment: git history explains change; state only a current constraint",
	},
	{ pattern: /\b(TODO|FIXME|XXX)\b/, message: "TODO left in the change: finish it or remove it" },
	{ pattern: /\bconsole\.log\(|\bdebugger\b|\bdbg!\(/, message: "debug output left in the change" },
];

export interface Finding {
	line: number;
	message: string;
	text: string;
}

/** Findings for added lines given as `[lineNumber, text]` pairs. */
export function lintLines(lines: Iterable<[number, string]>): Finding[] {
	const findings: Finding[] = [];
	for (const [line, text] of lines) {
		for (const rule of RULES) if (rule.pattern.test(text)) findings.push({ line, message: rule.message, text: text.trim() });
	}
	return findings;
}

/** Added lines of a pi-format diff (`+12 text`). */
export function addedLines(diff: string): [number, string][] {
	return diff.split("\n").flatMap((row): [number, string][] => {
		const match = /^\+\s*(\d+) (.*)$/.exec(row);
		return match ? [[Number(match[1]), match[2] ?? ""]] : [];
	});
}

function diffOf(details: unknown): string | undefined {
	if (details && typeof details === "object" && "diff" in details && typeof details.diff === "string") return details.diff;
	return undefined;
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", (event) => {
		if (event.isError || (event.toolName !== "edit" && event.toolName !== "write")) return;
		const lines =
			event.toolName === "write"
				? typeof event.input.content === "string"
					? event.input.content.split("\n").map((text, i): [number, string] => [i + 1, text])
					: []
				: addedLines(diffOf(event.details) ?? "");
		const findings = lintLines(lines);
		if (findings.length === 0) return;
		const report = findings.map((f) => `L${f.line}: ${f.message}\n  ${f.text.slice(0, 160)}`).join("\n");
		return { content: [...event.content, { type: "text", text: `\nLint (added lines):\n${report}` }] };
	});
}
