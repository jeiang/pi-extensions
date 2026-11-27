// A scripted language server for tests: a line containing ERROR is an error, `function name` declares
// a symbol that ends at the next line starting with `}`, and rename renames a word in every open document.
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
const docs = new Map<string, string>();

const publish = (uri: string) => {
	const text = docs.get(uri) ?? "";
	const diagnostics = text.split("\n").flatMap((line, i) => {
		const at = line.indexOf("ERROR");
		return at < 0 ? [] : [{ range: { start: { line: i, character: at }, end: { line: i, character: at + 5 } }, severity: 1, source: "fake", message: "ERROR found" }];
	});
	void connection.sendNotification("textDocument/publishDiagnostics", { uri, diagnostics });
};

const words = (text: string, word: string) =>
	text.split("\n").flatMap((line, i) => [...line.matchAll(new RegExp(`\\b${word}\\b`, "g"))].map((m) => ({ line: i, character: m.index ?? 0 })));

const wordAt = (uri: string, position: { line: number; character: number }) => {
	const line = (docs.get(uri) ?? "").split("\n")[position.line] ?? "";
	for (const m of line.matchAll(/\w+/g)) if ((m.index ?? 0) <= position.character && position.character <= (m.index ?? 0) + m[0].length) return m[0];
	return undefined;
};

connection.onRequest("initialize", () => ({
	capabilities: { textDocumentSync: 1, documentSymbolProvider: true, renameProvider: true, referencesProvider: true, definitionProvider: true },
	serverInfo: { name: "fake-lsp" },
}));
connection.onNotification("initialized", () => undefined);
connection.onNotification("textDocument/didOpen", (params: { textDocument: { uri: string; text: string } }) => {
	docs.set(params.textDocument.uri, params.textDocument.text);
	publish(params.textDocument.uri);
});
connection.onNotification("textDocument/didChange", (params: { textDocument: { uri: string }; contentChanges: { text: string }[] }) => {
	docs.set(params.textDocument.uri, params.contentChanges.at(-1)?.text ?? "");
	publish(params.textDocument.uri);
});
connection.onNotification("textDocument/didClose", (params: { textDocument: { uri: string } }) => {
	docs.delete(params.textDocument.uri);
});
connection.onRequest("textDocument/documentSymbol", (params: { textDocument: { uri: string } }) => {
	const rows = (docs.get(params.textDocument.uri) ?? "").split("\n");
	return rows.flatMap((line, i) => {
		const m = /function (\w+)/.exec(line);
		if (!m) return [];
		const end = rows.findIndex((row, j) => j > i && row.startsWith("}"));
		const range = { start: { line: i, character: 0 }, end: { line: end < 0 ? i : end, character: 1 } };
		const at = m.index + "function ".length;
		return [{ name: m[1], kind: 12, range, selectionRange: { start: { line: i, character: at }, end: { line: i, character: at + (m[1]?.length ?? 0) } } }];
	});
});
connection.onRequest("textDocument/references", (params: { textDocument: { uri: string }; position: { line: number; character: number } }) => {
	const word = wordAt(params.textDocument.uri, params.position);
	if (!word) return [];
	return [...docs].flatMap(([uri, text]) => words(text, word).map((start) => ({ uri, range: { start, end: { line: start.line, character: start.character + word.length } } })));
});
connection.onRequest("textDocument/rename", (params: { textDocument: { uri: string }; position: { line: number; character: number }; newName: string }) => {
	const word = wordAt(params.textDocument.uri, params.position);
	if (!word) return null;
	const changes: Record<string, unknown[]> = {};
	for (const [uri, text] of docs) {
		const edits = words(text, word).map((start) => ({ range: { start, end: { line: start.line, character: start.character + word.length } }, newText: params.newName }));
		if (edits.length) changes[uri] = edits;
	}
	return { changes };
});
connection.onRequest("shutdown", () => null);
connection.onNotification("exit", () => process.exit(0));
connection.listen();
