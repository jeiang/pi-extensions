# codemode

Run a JavaScript program that calls the other tools, filters their output, and returns only what matters.

## Use instead of
- one tool call per step with large outputs → one codemode script
- `cmd1; cmd2 | jq` → run() each under settle(), filter in JS

## Examples
```js
const [log, status] = await settle([run("git log --oneline -5").text(), run("git status --short").text()]);
return { log, status };
```

## Errors
- A script with no timeout_ms is killed at 15 minutes.

## Related
run, tool_docs
