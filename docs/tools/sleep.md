# sleep

Wait up to 300 seconds in a script. Scripts only.

## Use instead of
- `sleep N` in a command → sleep, or better job wait on what you are waiting for

## Examples
```js
await sleep(30);
```

## Errors
- More than 300 seconds is cut to 300.

## Related
job, poll()
