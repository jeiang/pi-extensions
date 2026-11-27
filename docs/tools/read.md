# read

Read a file as numbered rows under a [path#TAG] header that edit anchors on, or an image.

## Use instead of
- `cat`, `sed -n a,bp`, `head`, `tail` → read with offset/limit or ranges

## Examples
```js
await tools.read({ path: "src/a.ts", ranges: [{ start: 10, end: 40 }] });
```

## Errors
- A whole-file re-read of an unchanged file returns only the header and a digest.

## Related
read_text (raw text in scripts), edit
