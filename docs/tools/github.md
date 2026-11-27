# github

Pull requests, CI runs, workflow dispatch, and repository content on GitHub, in the checkout's repository or any owner/name in repo.

## Use instead of
- `gh pr view/create/merge/list/comment/close/edit` → github pr_* ops
- `gh pr checks --watch`, `sleep` then `gh pr view` → github pr_watch (until: checks waits for CI without merging)
- `gh run watch`, `gh run view --log`, `gh run list` → github run_watch, run_log, run_list
- `curl raw.githubusercontent.com`, `gh api …/contents` → github repo_file, repo_tree
- `gh workflow run` → github workflow_run

## Examples
```js
await tools.github.pr_create({ title: "fix: x", body: "…", push: true });
await tools.github.pr_watch({ pr: "42", until: "checks" });
await tools.github.pr_merge({ pr: "42", method: "squash", expect_head: "a1b2c3d" });
await tools.github.repo_file({ repo: "cli/cli", path: "README.md", ref: "v2.0.0" });
await tools.github.run_log({ run: "123", failed: true, grep: "error", tail: 80 });
```

## Errors
- "must first push": pass push: true.
- Transient GitHub errors retry on their own; a write retries only after checking it did not happen.

## Related
job (watches the user interrupted), worktree (ff_main after a merge)
