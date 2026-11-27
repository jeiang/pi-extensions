import { isAbsolute, relative } from "node:path";
import type { Diagnostic, DocumentSymbol, Position, Range, SymbolInformation } from "vscode-languageserver-protocol";
import type { Encoding } from "./client.ts";

export const lines = (text: string) => text.split(/\r?\n|\r/);

/** Code units of `ch` in an encoding: UTF-16 counts surrogate pairs as two, UTF-8 counts bytes. */
function units(ch: string, encoding: Encoding): number {
	const cp = ch.codePointAt(0) ?? 0;
	if (encoding === "utf-32") return 1;
	if (encoding === "utf-16") return cp > 0xffff ? 2 : 1;
	return cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
}

/** A 0-based code point column on `line` as a server character. */
export function toServerCharacter(line: string, column: number, encoding: Encoding): number {
	let count = 0;
	let i = 0;
	for (const ch of line) {
		if (i++ >= column) break;
		count += units(ch, encoding);
	}
	return count;
}

/** A server character on `line` as a 0-based code point column. */
export function toColumn(line: string, character: number, encoding: Encoding): number {
	let count = 0;
	let column = 0;
	for (const ch of line) {
		if (count >= character) break;
		count += units(ch, encoding);
		column++;
	}
	return column;
}

/** The UTF-16 offset in `text` of a server position, clamped to the line. */
export function offsetAt(text: string, position: Position, encoding: Encoding): number {
	let offset = 0;
	for (let line = 0; line < position.line; line++) {
		const next = text.slice(offset).search(/\r\n|\n|\r/);
		if (next < 0) return text.length;
		offset += next + (text.startsWith("\r\n", offset + next) ? 2 : 1);
	}
	const end = text.slice(offset).search(/\r\n|\n|\r/);
	const line = end < 0 ? text.slice(offset) : text.slice(offset, offset + end);
	const column = toColumn(line, position.character, encoding);
	return offset + [...line].slice(0, column).join("").length;
}

export const displayPath = (absolute: string, cwd: string) => {
	const rel = relative(cwd, absolute);
	return rel.startsWith("..") || isAbsolute(rel) ? absolute : rel;
};

const SEVERITY = ["", "error", "warning", "info", "hint"];
export const severityName = (severity: number | undefined) => SEVERITY[severity ?? 1] ?? "error";

/** `path:line:col severity source(code): message`, 1-based, columns in code points. */
export function diagnosticLine(path: string, text: string | undefined, d: Diagnostic, encoding: Encoding): string {
	const line = text === undefined ? "" : (lines(text)[d.range.start.line] ?? "");
	const column = text === undefined ? d.range.start.character : toColumn(line, d.range.start.character, encoding);
	const code = d.code === undefined ? "" : `(${String(d.code)})`;
	const source = d.source || code ? ` ${d.source ?? ""}${code}` : "";
	return `${path}:${d.range.start.line + 1}:${column + 1} ${severityName(d.severity)}${source}: ${(typeof d.message === "string" ? d.message : d.message.value).replace(/\s*\n\s*/g, " ")}`;
}

const KINDS = [
	"",
	"file",
	"module",
	"namespace",
	"package",
	"class",
	"method",
	"property",
	"field",
	"constructor",
	"enum",
	"interface",
	"function",
	"variable",
	"constant",
	"string",
	"number",
	"boolean",
	"array",
	"object",
	"key",
	"null",
	"enum member",
	"struct",
	"event",
	"operator",
	"type parameter",
];
export const kindName = (kind: number) => KINDS[kind] ?? "symbol";

export interface FlatSymbol {
	name: string;
	/** Dotted path of enclosing symbol names and this one. */
	path: string;
	kind: number;
	range: Range;
	selection: Range;
	depth: number;
}

/** Document symbols in document order, children after their parent. */
export function flattenSymbols(symbols: (DocumentSymbol | SymbolInformation)[]): FlatSymbol[] {
	const out: FlatSymbol[] = [];
	const walk = (list: (DocumentSymbol | SymbolInformation)[], parent: string, depth: number) => {
		for (const symbol of list) {
			if ("location" in symbol) {
				out.push({ name: symbol.name, path: symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name, kind: symbol.kind, range: symbol.location.range, selection: symbol.location.range, depth: 0 });
				continue;
			}
			const path = parent ? `${parent}.${symbol.name}` : symbol.name;
			out.push({ name: symbol.name, path, kind: symbol.kind, range: symbol.range, selection: symbol.selectionRange, depth });
			walk(symbol.children ?? [], path, depth + 1);
		}
	};
	walk(symbols, "", 0);
	return out.sort((a, b) => a.range.start.line - b.range.start.line || a.depth - b.depth);
}

/** `name` or `Parent.name`, with an optional `#n` for the nth match; else an error naming close ones. */
export function findSymbol(symbols: FlatSymbol[], query: string): FlatSymbol {
	const [, name = query, nth = "1"] = /^(.*?)(?:#(\d+))?$/.exec(query) ?? [];
	const matches = symbols.filter((s) => s.path === name || s.name === name || s.path.endsWith(`.${name}`));
	const found = matches[Number(nth) - 1];
	if (found) return found;
	const lower = name.toLowerCase();
	const close = symbols
		.filter((s) => s.path.toLowerCase().includes(lower) || lower.includes(s.name.toLowerCase()))
		.slice(0, 8)
		.map((s) => s.path);
	const hint = close.length ? ` Close: ${close.join(", ")}.` : symbols.length ? ` Symbols: ${symbols.slice(0, 12).map((s) => s.path).join(", ")}.` : "";
	throw new Error(matches.length ? `${name} has ${matches.length} match(es), not ${nth}.` : `No symbol ${name}.${hint}`);
}
