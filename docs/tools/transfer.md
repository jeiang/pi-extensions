# transfer

Copy a file or directory to or from a host with scp, over the session's shared ssh connection.

## Use instead of
- `scp`, `rsync` to a host → transfer
- `echo $b64 | base64 -d > file` over ssh → transfer upload, or run with stdin

## Examples
```js
await tools.transfer({ host: "artemis", direction: "upload", local: "dist/app.tar", remote: "/tmp/app.tar" });
```

## Errors
- ssh failures name the host; BatchMode is on, so a host that asks for a password fails.

## Related
run (host)
