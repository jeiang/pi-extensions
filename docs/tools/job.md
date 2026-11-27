# job

Reach work that runs past its call: run handles, background subagents (by session), background scripts, and CI or PR watches.

## Use instead of
- `sleep N` before checking again → job wait with wait_on or wait_seconds
- `kill`, `pkill -f` on a command you started → job kill
- `tail -f log` → job read

## Examples
```js
await tools.job({ action: "status" });
await tools.job.wait({ job: "job3", wait_on: "listening", wait_seconds: 60 });
await tools.job({ action: "write", job: "job4", input: "yes\n" });
```

## Errors
- "No job …": the id is wrong or the job finished and its result was already returned.
- write needs a command started with run interactive: true.

## Related
run, subagent, github
