# replace

Replace exact text in one file, without line numbers.

## Use instead of
- `sed -i s/a/b/ file` → replace

## Examples
```js
await tools.replace({ path: "README.md", old_string: "v1", new_string: "v2" });
```

## Errors
- old_string must match exactly once unless replace_all.

## Related
edit, substitute
