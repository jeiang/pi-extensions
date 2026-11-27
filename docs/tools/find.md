# find

Find files by glob, respecting .gitignore. Scripts only.

## Use instead of
- `find . -name`, `ls **/*.ts` → find

## Examples
```js
const { paths } = await tools.find({ pattern: "**/*.test.ts" });
```

## Errors
- Results stop at the limit; a notice says so.

## Related
ls, grep
