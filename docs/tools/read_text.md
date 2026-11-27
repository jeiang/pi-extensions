# read_text

A text file's raw contents for a script to parse, up to 64 MiB. Scripts only.

## Use instead of
- `run("cat file")` to parse a file → read_text, or fs.text(path)

## Examples
```js
const { text } = await tools.read_text({ path: "package.json" });
```

## Errors
- Larger files need read with ranges.

## Related
read
