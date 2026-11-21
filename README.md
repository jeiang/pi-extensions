# pi-extensions

Extensions for the [pi](https://github.com/earendil-works/pi) coding agent.

| Extension | Purpose |
|---|---|
| `guards` | Blocks permanent installs and git history rewrites in `bash`/`shell` (the user can allow one in a dialog), asks before any tool touches `~/.ssh`, `~/.gnupg`, `~/.config/sops`, `~/Library`, or `/etc`, and masks secrets in tool output. |
| `chains` | Fallback chains as virtual models (`chain/<name>`): per-provider cooldowns shared across processes, retries and usage limits move to the next target, compaction at a per-chain token count, `/chain-reset`. |
| `workspace` | Owns the session's working directory: the git worktree (the `worktree` tool creates `.worktrees/<name>` from the default branch, enters an existing branch, removes the current worktree keeping its branch, lists, prunes clean merged worktrees, and carries uncommitted main-checkout changes in through a stash; `/worktree` creates one; writes and git mutations in the main checkout are blocked until one exists; the choice survives a resumed session; subagent children and the `github`, `images`, and `guards` extensions follow it; the main checkout fast-forwards to the default branch after create, remove, prune, or a merged pull request), the devshell (devenv, flake, or `shell.nix`, cached per lock file, resolved again when its files change), hashline `read`/`edit`/`write` on `@oh-my-pi/pi-natives` (snapshot tags, `PUT`/`CUT` patches), the file tool overrides (`grep`, `find`, `ls`, and `bash` are callable from codemode only), and the `shell` tool (background jobs with early return on a regex or time, wake on match or exit, lone `rg`/`grep` routed to the grep tool), and the `python` tool (a persistent Python kernel in the devshell or the repository's `.venv`; `python -c`, heredocs, piped stdin, and bare interpreters in `bash`/`shell` are blocked and redirected to it, while script files and `python -m` still run). |
| `advisor` | Reviews each finished run with a second model (`advisor.json`: `models` tried in order, `timeoutMs`, `rubric`); non-LGTM advice starts at most one follow-up turn per user input. Also an `advise` tool. Leave it out of subagents. |
| `lint` | Appends findings for lines an `edit`/`write` adds: history comments, `TODO`/`FIXME`, debug output. |
| `emphasis` | Draws `[[Word]]` status pills and label icons in interactive replies and tells the model the vocabulary (adapted from [pi-emphasis](https://github.com/johnlindquist/pi-emphasis), MIT). |
| `turn-time` | Elapsed time while the agent works; the last turn's time in the footer. |
| `usage` | Subscription usage limits of OAuth logins (Claude 5h/7d and model-scoped weeklies, ChatGPT Codex windows) in the footer, refreshed at most once a minute after a run; `/usage` lists every window with its reset time. |
| `github` | `run_watch` (CI jobs and steps until done, fail fast with the failed log tail) and `pr_view`. |
| `images` | Draws a reply's ```` ```svg ```` blocks (rasterized by the `resvg` CLI on `PATH`) and linked local images below it, in interactive sessions. |
| `loadout` | Leaves the tools named in `loadout.json` (`{"hidden": [...]}`) out of the model's tool list; they stay callable from codemode and findable with `searchTools()`. |
| `skill-mentions` | Skills mid-prompt: typing `$` opens a skill menu that inserts `/skill:name`, and a `/skill:name` anywhere in a prompt loads that skill (pi itself expands only a leading one). |

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
