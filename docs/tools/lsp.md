# lsp

Language-server navigation, diagnostics, and refactors: definitions, references, hover, outlines, call hierarchy, workspace symbol search, diagnostics for files or directories, and rename, file moves, and code actions through a preview and token.

## Use instead of
- `grep` for a function's definition or its callers → lsp definition, references, calls
- `tsc --noEmit` or a linter run to see one file's errors → lsp diagnostics
- `substitute` or `sed` to rename an identifier → lsp rename
- `git mv` plus hand-edited imports → lsp rename_file

## Examples
```js
await tools.lsp({ op: "definition", path: "src/a.ts", line: 12, symbol: "parse" });
await tools.lsp.references({ path: "src/a.ts", symbol: "Parser.parse" });
await tools.lsp.diagnostics({ paths: ["src"] });
const preview = await tools.lsp.rename({ path: "src/a.ts", symbol: "parse", new_name: "parseAll" });
await tools.lsp.rename({ apply: true, token: preview.token });
```

## Errors
- No language server is configured for a file: settings.json lsp.servers has no entry for its extension.
- apply refuses when a file changed since the preview; preview again.
- A server that fails to start is retried after a backoff; /lsp restart retries at once.

## Related
read (with symbol), grep, substitute
