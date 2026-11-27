# subagent

Run one read-only child agent and get its final answer; background runs wake you and job waits on them.

## Use instead of
- reading many files yourself to locate code → subagent scout
- a question that needs the web → subagent researcher

## Examples
```js
await tools.subagent({ agent: "scout", task: "Find where tokens are refreshed in src/auth; paths and line ranges." });
```

## Errors
- A failed child names its session; resume it with resume.

## Related
job
