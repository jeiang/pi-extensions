# tool_docs

Find the tool for a job, or read one tool's full documentation: purpose, the habits it replaces, parameters, results, examples, and errors.

## Use instead of
- guessing a tool's parameters → tool_docs with name
- a shell habit when a tool may exist → tool_docs with query

## Examples
```js
await tools.tool_docs({ query: "wait for CI without merging" });
await tools.tool_docs({ name: "github" });
```

## Errors
- An unknown name lists the closest tools.

## Related
codemode (searchTools, describeTool)
