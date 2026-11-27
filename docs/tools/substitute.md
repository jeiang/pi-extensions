# substitute

Regex replace across many files: a preview with counts and samples, then apply with its token. Scripts only.

## Use instead of
- `sed -i` over many files, `grep -l | xargs sed` → substitute

## Examples
```js
const preview = await tools.substitute({ pattern: "oldName", replacement: "newName", glob: "*.ts" });
await tools.substitute({ pattern: "oldName", replacement: "newName", glob: "*.ts", apply: true, token: preview.token });
```

## Errors
- apply refuses when a searched file changed since the preview.

## Related
replace, edit
