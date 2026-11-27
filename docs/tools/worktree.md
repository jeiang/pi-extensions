# worktree

Control the session's git worktree under .worktrees/, or worktrees of another repository with repo.

## Use instead of
- `git checkout`, `git switch` in the main checkout → worktree create or enter
- `git worktree add/remove` → worktree create, remove, exit, prune
- `git checkout main && git merge --ff-only` → worktree ff_main

## Examples
```js
await tools.worktree.create({ name: "fix-parser" });
await tools.worktree.ff_main({});
await tools.worktree.prune({});
```

## Errors
- Writes in the main checkout are blocked until create or enter.
- ff_main refuses anything but a fast-forward and never pushes.

## Related
github (pr_merge), run (cwd)
