const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const DIVIDER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
// A number with an optional currency sign and unit. Versions (1.2.3) and ranges do not match.
const NUMBER = /^([$€£]?)(\d[\d,]*(?:\.\d+)?|\.\d+)\s*([a-zA-Z%°µ/]*)$/;
const EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const BAR_CELLS = 30;

const cells = (row: string) =>
	row
		.trim()
		.replace(/^\||\|$/g, "")
		.split(/(?<!\\)\|/)
		.map((cell) => cell.replace(/[*`]/g, "").trim());

/** Bars for a table of one text column and numeric columns that share a unit; undefined for any other table. */
function bars(header: string[], rows: string[][]): string[] | undefined {
	if (rows.length < 2 || header.length < 2 || rows.some((row) => row.length !== header.length)) return undefined;
	if (rows.every((row) => NUMBER.test(row[0] ?? ""))) return undefined;
	const numbers = rows.map((row) => row.slice(1).map((cell) => cell.match(NUMBER)));
	const units = new Set(numbers.flat().map((match) => (match ? `${match[1]}|${match[3]}` : undefined)));
	if (units.size !== 1 || units.has(undefined)) return undefined;
	const values = numbers.map((row) => row.map((match) => Number(match?.[2]?.replace(/,/g, ""))));
	const max = Math.max(...values.flat());
	if (!(max > 0)) return undefined;
	const labelWidth = Math.max(...rows.map((row) => (row[0] ?? "").length));
	return header.slice(1).flatMap((title, column) => [
		...(header.length > 2 ? [`${title}:`] : []),
		...rows.map((row, index) => {
			const eighths = Math.round(((values[index]?.[column] ?? 0) / max) * BAR_CELLS * 8);
			return `${(row[0] ?? "").padEnd(labelWidth)} ${"█".repeat(eighths >> 3)}${EIGHTHS[eighths & 7]} ${row[column + 1]}`;
		}),
	]);
}

/** Appends a bar chart in text cells under each Markdown table whose numbers can be compared. */
export function chartTables(markdown: string): string {
	const lines = markdown.split("\n");
	const out: string[] = [];
	let fence: string | undefined;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		out.push(line);
		const marker = line.match(FENCE)?.[1];
		if (fence) {
			if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
			continue;
		}
		if (marker) {
			fence = marker;
			continue;
		}
		if (!line.includes("|") || !DIVIDER.test(lines[i + 1] ?? "")) continue;
		const rows: string[][] = [];
		let end = i + 2;
		for (; end < lines.length && (lines[end] ?? "").includes("|"); end++) rows.push(cells(lines[end] ?? ""));
		out.push(...lines.slice(i + 1, end));
		i = end - 1;
		const chart = bars(cells(line), rows);
		// A paragraph with hard breaks; no-break spaces keep the bars aligned.
		if (chart) out.push("", ...chart.map((row) => `${row.replace(/ /g, "\u00a0")}  `));
	}
	return out.join("\n");
}
