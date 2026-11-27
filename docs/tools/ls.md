# ls

List a directory, directories ending in /. Scripts only.

## Use instead of
- `ls`, `ls -la` → ls

## Examples
```js
const { entries } = await tools.ls({ path: "src" });
```

## Errors
- Stops at 500 entries; a notice says so.

## Related
find
