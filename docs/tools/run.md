# run

Run one command: locally in bash inside the directory's devshell, or with `host` on another machine over one shared ssh connection per host.

## Use instead of
- `bash`, `sh`, `ssh host cmd`, `nix develop .#name -c cmd` → run(cmd, { host, devshell })
- `cmd | head`, `cmd | tail` → run(cmd, { tail: N }), then read the log
- `cmd &`, `sleep N; check`, `pkill` → run(cmd, { background: true }) and job wait/kill
- `sudo` without a terminal → fails at once; ask the user, or tty: true when they are there

## Examples
```js
const r = await run("npm test", { tail: 40, timeout: 600 });
const pkg = await run("cat package.json").json();
const files = await run("git ls-files", { check: true }).lines();
const up = await run("systemctl is-active nginx", { host: "artemis" });
const server = await run("npm run dev", { wait_on: "ready", background: true });
await server.kill();
```

## Errors
- A non-zero exit returns exit_code and isError; pass check: true to throw instead.
- timeout kills the command; wait_seconds only returns a handle while it keeps running.
- "devshell applies to local commands": a host runs its own shell.

## Related
job, transfer, read (the log)
