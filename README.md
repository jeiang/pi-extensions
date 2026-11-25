# pi-extensions

Extensions for the [pi](https://github.com/earendil-works/pi) coding agent.

| Extension | Purpose |
|---|---|
| `guards` | Blocks permanent installs and git history rewrites in `bash`/`shell`/`ssh`, and local `git checkout`/`git switch` of the session checkout, pointing to the worktree tool (the user can allow one in a dialog), asks before any tool touches `~/.ssh`, `~/.gnupg`, `~/.config/sops`, or `/etc`, and masks secrets in tool output. |
| `chains` | Fallback chains as virtual models (`chain/<name>`): per-provider cooldowns shared across processes, retries and usage limits move to the next target, compaction once a run settles above a per-chain token count (interactive sessions), `/chain-reset`. |
| `server-compaction` | Compacts on the provider's side for Anthropic (`api.anthropic.com`) and ChatGPT Codex: saves the signed or encrypted checkpoint in the compaction entry and sends it in place of the summary to the model that made it; other models, including chain fallbacks, get the text summary. A failed server compaction falls back to pi's summary with a warning. Anthropic rejects message threads with a checkpoint, so pi resends the first request after a compaction without one and stops using threads for that session. |
| `workspace` | Owns the session's working directory: the git worktree (the `worktree` tool creates `.worktrees/<name>` from the default branch, enters an existing branch, removes the current worktree keeping its branch, lists, prunes clean worktrees merged by a merge commit, squash, or rebase (the current one included) with their branches, and carries uncommitted main-checkout changes in through a stash; `/worktree` creates one; writes in the main checkout are blocked until one exists, unless the repository had no commits when the session started (the tool still works once it has some); nested clones inside the checkout (a `.git` directory, not a submodule) are left alone, reached by absolute path once a worktree exists; the choice survives a resumed session; the `github`, `images`, and `guards` extensions follow it; the main checkout fast-forwards to the default branch after create, remove, prune, or a merged pull request), the devshell (devenv, flake, or `shell.nix`, cached per lock file, resolved again when its files change), hashline `read`/`edit`/`write` on `@oh-my-pi/pi-natives` (snapshot tags, `PUT`/`CUT` patches), the file tool overrides (`grep`, `find`, and `ls` hand scripts structured results; `find`, `ls`, `read_text` (a file's raw text), `bash`, `shell`, and `ssh` are callable from codemode only; `bash` and `ssh` run as `shell` jobs; `ssh` shares one connection per host and option set for the session, takes `-o` options, defaults to `BatchMode=yes`, and runs the command under the remote bash whatever the login shell), and the `shell` tool (background jobs with early return on a regex or time, wake on match or exit, lone `rg`/`grep` routed to the grep tool; in the live view a carriage-return progress line updates in place and a line such as `[3/12]`, `3 of 12`, or `45%` gets a bar), and the `subagent` tool (one read-only child per call, a `pi -p` subprocess in the session directory built from an `agents/*.md` definition: model, tools, extensions, prompt; foreground, or `background` with a wake on its result; at most `maxConcurrent` at once (`subagent.json`, default 3; `/subagents <n>` for the session); the child session is saved under the parent session directory). Alt+Enter while a `shell` command, codemode `bash`, foreground `subagent`, or `github` `run_watch` runs moves it to the background and delivers the message as a steer; otherwise Alt+Enter stays a follow-up. |
| `advisor` | Reviews a run that changed files or ran processes with a second model before it settles, except a run that proposed a plan, whose plan it reviews instead (see `plan`) (`advisor.json`: `models` tried in order, `timeoutMs`, `rubric`, and `enabled`, which defaults to off; `/advisor on` turns it on for a session). A `blocker` or `concern` continues the run once per user input and the agent then writes its final report again in full; nits are drawn on a card the agent does not see. Also an `advise` tool. Leave it out of subagents. |
| `plan` | `/plan [prompt]` toggles plan mode: the agent explores read-only (edit tools work only in the session's `plans/` directory; `worktree` changes and `pr_create`/`pr_merge` are blocked; shell commands are held back by instruction only), writes a standalone plan file, and submits it with the `propose` tool. When the advisor is on, `propose` first shows "Advisor reviewing the plan…" and has it review the plan: blockers and concerns go back to the agent once per user input, nits go on the review card. The review card shows the plan and offers approve and execute here, approve and execute in a new session (pick its model and thinking level), revise with feedback, or edit the plan; `/plan-review` reopens it. |
| `papercuts` | A `papercut` tool for the agent to report harness friction (a tool that is `broken`, a `missing` feature, a `misleading` description or error, or other `friction`); each report is a line in `papercuts.jsonl` in the agent directory with an id, the time, model, cwd, and session file, so a report leads back to its transcript; the subagents load it too. The `papercut-review` skill (`/skill:papercut-review`) clusters open reports, verifies them against the code and transcripts, fixes the approved ones, and records each fix in `papercuts-resolved.jsonl`. |
| `lint` | Appends findings for lines an `edit`/`write` adds: history comments, `TODO`/`FIXME`, debug output. |
| `emphasis` | In interactive replies, draws an icon on the report labels that `prompts/AGENTS.md` names and on links (one for a URL, one for a local path), colors `✓`, `✗`, `→`, and tree lines, and draws bars under a table of one text column and numeric columns that share a unit (adapted from [pi-emphasis](https://github.com/johnlindquist/pi-emphasis), MIT). |
| `turn-time` | Elapsed time while the agent works; the last turn's time as a status the footer draws. |
| `footer` | Replaces pi's footer: model and thinking level, session directory (worktree icon in one), git branch with `*unstaged +staged ?untracked` counts, tokens in and out, cache read and write, cost, context percent and the model's context window (`25% / 272k`; colored at 50/70/90), subscription windows from `usage` (colored at 50/80), the last turn time, and the statuses of other extensions. One icon per segment (Nerd Font). Only one extension can own the footer. Tokens and cost cover the branch's nested model calls too (advisor, subagents, tools, compaction); `/cost` splits them by source. |
| `usage` | Subscription usage limits of OAuth logins (Claude 5h/7d and model-scoped weeklies, ChatGPT Codex windows), refreshed at most once a minute after a run and published for `footer`; `/usage` charts every window as a bar with used, remaining, and reset time. |
| `github` | `run_watch` (CI jobs and steps of a commit, HEAD by default, until done, fail fast with the failed log tail; Alt+Enter moves it to the background, which wakes the agent with the outcome), `pr_view`, `pr_create`, and `pr_merge` (a method, optionally `auto` and `delete_branch`). |
| `images` | Draws a reply's ```` ```svg ```` blocks (rasterized by the `resvg` CLI on `PATH`) and linked local images below it, in interactive sessions. |
| `loadout` | Leaves the tools named in `loadout.json` (`{"hidden": [...]}`) out of the model's tool list; they stay callable from codemode and findable with `searchTools()`. |
| `skill-mentions` | Skills mid-prompt: typing `$` or `/skill:` opens a skill menu that inserts `/skill:name`, and a `/skill:name` anywhere in a prompt loads that skill (pi itself expands only a leading one). Its editor draws a completed `/skill:name` as one chip that Backspace deletes whole; it widens two private fields of pi's editor, so retest it on each pi bump. Only one extension can own the editor. |

The package also bundles the third-party pi packages the setup loads, so one
lock file pins them: `pi-lens`, `@ian-pascoe/pi-lsp`, and `pi-web-access`,
under `node_modules/`.

It also carries the text pi reads, so a tool and the prompt that describes it
change in one commit: `prompts/AGENTS.md` (the global instructions),
`agents/` (subagent definitions), and `skills/` (pi's own skills, such as `papercut-review`). The
other skills come from agent-skills.

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
