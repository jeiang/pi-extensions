# edit

Patch files with hashline operations anchored on the tag and line numbers of the latest read.

## Use instead of
- `sed -i`, a python heredoc that rewrites a file → edit, or replace for one exact passage

## Examples
```
[src/a.ts#1A2B]
PUT 12.=14:
+const x = 1;
```

## Errors
- A stale tag or unseen lines are refused with the current tag; re-read first.

## Related
read, replace, write
