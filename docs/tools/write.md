# write

Create a file or overwrite it completely.

## Use instead of
- `cat > file <<EOF` → write

## Examples
```js
await tools.write({ path: "notes.md", content: "# Notes\n" });
```

## Errors
- Writes in the main checkout are blocked until a worktree exists.

## Related
edit, replace
