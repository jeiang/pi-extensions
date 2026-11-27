# grep

Search file contents with ripgrep, respecting .gitignore; multiline lets a pattern span lines.

## Use instead of
- `grep -rn`, `rg` → grep

## Examples
```js
const { lines } = await tools.grep({ pattern: "export function", path: "src", glob: "*.ts" });
await tools.grep({ pattern: "foo\\(\\n\\s+bar", multiline: true });
```

## Errors
- A literal \n in the pattern needs multiline: true.

## Related
find, read
