# pi-extensions

Extensions for the [pi](https://github.com/earendil-works/pi) coding agent.

| Extension | Purpose |
|---|---|
| `guards` | Blocks permanent installs and git history rewrites in `bash`/`shell` (the user can allow one in a dialog), asks before any tool touches `~/.ssh`, `~/.gnupg`, `~/.config/sops`, `~/Library`, or `/etc`, and masks secrets in tool output. |
| `chains` | Fallback chains as virtual models (`chain/<name>`): per-provider cooldowns shared across processes, retries and usage limits move to the next target, compaction at a per-chain token count, `/chain-reset`. |
| `workspace` | Owns the session's working directory: the git worktree (the first `edit`/`write`, the `worktree` tool, or `/worktree` creates `.worktrees/<name>` from the default branch; git mutations in the main checkout are blocked until then), the devshell (direnv, devenv, flake, or `shell.nix`, cached per lock file), hashline `read`/`edit`/`write` on `@oh-my-pi/pi-natives` (snapshot tags, `PUT`/`CUT` patches), the file tool overrides (`grep`, `find`, `ls`, and `bash` are callable from codemode only), and the `shell` tool (background jobs with early return on a regex or time, wake on match or exit, lone `rg`/`grep` routed to the grep tool). |
| `advisor` | Reviews each finished run with a second model (`advisor.json`: `models` tried in order, `timeoutMs`, `rubric`); non-LGTM advice starts at most one follow-up turn per user input. Also an `advise` tool. Leave it out of subagents. |
| `lint` | Appends findings for lines an `edit`/`write` adds: history comments, `TODO`/`FIXME`, debug output. |
| `emphasis` | Draws `[[Word]]` status pills and label icons in interactive replies and tells the model the vocabulary (adapted from [pi-emphasis](https://github.com/johnlindquist/pi-emphasis), MIT). |
| `turn-time` | Elapsed time while the agent works; the last turn's time in the footer. |
| `github` | `run_watch` (CI jobs and steps until done, fail fast with the failed log tail) and `pr_view`. |
| `images` | Draws a reply's ```` ```svg ```` blocks (rasterized by the `resvg` CLI on `PATH`) and linked local images below it, in interactive sessions. |

The package also bundles the third-party pi packages the setup loads, so one
lock file pins them: `pi-lens`, `@ian-pascoe/pi-lsp`, and `pi-web-access`,
under `node_modules/`.

## chains

Reads `chains.json` from the agent directory (or `PI_CHAINS_CONFIG`):

```json
{
  "chains": {
    "strong": {
      "compactAt": 400000,
      "targets": ["anthropic/claude-opus-5-5:medium", "openai-codex/gpt-6.1-sol:high"]
    }
  }
}
```

A retryable failure (overload, 429, 5xx) cools the provider for a minute and
the retry goes to the next target. A subscription usage limit cools the
provider for an hour and the run continues on the next target. Requests
after tool results stay on the model that answered, to keep its prompt
cache.
