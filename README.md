# pi-extensions

Extensions for the [pi](https://github.com/earendil-works/pi) coding agent.

| Extension | Purpose |
|---|---|
| `guards` | Stops permanent installs and git history rewrites in `bash`/`shell`/`ssh`, branch switches that move the main checkout or check out the default branch elsewhere (switches inside a worktree pass), any access to `~/.ssh`, `~/.gnupg`, or `~/.config/sops`, and writes to `/etc` (reads pass), and masks secrets in tool output. A stopped call asks the user to allow, deny, or deny with a reason the agent sees; unanswered, it is denied after 120s, so an unattended run does not hang. The rules are listed in the system prompt so the agent avoids them. |
| `chains` | Fallback chains as virtual models (`chain/<name>`): per-provider cooldowns shared across processes, retries and usage limits move to the next target, compaction once a run settles above a per-chain token count, or above `compactRatio` of the model's context window when the chain has none (interactive sessions), `/chain-reset`. |
| `server-compaction` | Compacts on the provider's side for Anthropic (`api.anthropic.com`) and ChatGPT Codex: saves the signed or encrypted checkpoint in the compaction entry and sends it in place of the summary to the model that made it; other models, including chain fallbacks, get the text summary. A failed server compaction falls back to pi's summary with a warning. Anthropic rejects message threads with a checkpoint, so pi resends the first request after a compaction without one and stops using threads for that session. |
| `workspace` | Owns the session's working directory: the git worktree (the `worktree` tool creates `.worktrees/<name>` from the default branch, enters an existing branch, removes the current worktree keeping its branch, exits to the main checkout (deleting a merged branch, keeping an unmerged one), lists, prunes clean worktrees merged by a merge commit, squash, or rebase (the current one included) with their branches, carries uncommitted main-checkout changes in through a stash, and fast-forwards the default branch to a branch or commit (`ff_main`, local only, refusing anything but a fast-forward); `/worktree` creates one; writes in the main checkout are blocked until one exists, unless the repository had no commits when the session started (the tool still works once it has some); nested clones inside the checkout (a `.git` directory, not a submodule) are left alone, reached by absolute path once a worktree exists; the choice survives a resumed session; the `github`, `images`, and `guards` extensions follow it; the main checkout fast-forwards to the default branch after create, remove, prune, or a merged pull request), the devshell (devenv, flake, or `shell.nix`, cached per lock file, resolved again when its files change), hashline `read`/`edit`/`write` on `@oh-my-pi/pi-natives` (snapshot tags, `PUT`/`CUT` patches; a whole-file re-read of an unchanged file answers with a digest, and a rejected edit names the file's current tag), the file tool overrides (`grep`, `find`, and `ls` hand scripts structured results; `find`, `ls`, `read_text` (a file's raw text, up to 64 MiB), `substitute`, `bash`, `shell`, and `ssh` are callable from codemode only; `grep` takes `multiline`; `bash` and `ssh` run as `shell` jobs; `ssh` shares one connection per host and option set for the session, takes `-o` options plus `-t`, `-n`, `-i`, `-p`, and `-A`, returns as a background job after 120s instead of holding the turn, defaults to `BatchMode=yes`, and runs the command under the remote bash whatever the login shell), and the `shell` tool (background jobs with early return on a regex or time, wake on match or exit, a wait with no selector returns after 120s with the job still running, stdout and stderr captured apart (`tty` runs the command under a pty for sudo, on `shell` and on a script's `run`), lone `rg`/`grep` routed to the grep tool; in the live view a carriage-return progress line updates in place and a line such as `[3/12]`, `3 of 12`, or `45%` gets a bar), and the `subagent` tool (one read-only child per call, a `pi -p` subprocess in the session directory built from an `agents/*.md` definition: model, tools, extensions, prompt; foreground, or `background` with a wake on its result; at most `maxConcurrent` at once (`subagent.json`, default 3; `/subagents <n>` for the session); the child session is saved under the parent session directory; `briefs` runs several in one call; `/btw <question>` asks the `btw` agent in a throwaway session seeded with the checkpoint, shows the answer in the TUI, and adds nothing to the conversation). Alt+Enter while a `shell` command, codemode `bash`, foreground `subagent`, or `github` `run_watch` runs moves it to the background and delivers the message as a steer; otherwise Alt+Enter stays a follow-up. |
| `advisor` | Reviews a run that changed files or ran processes with a second model before it settles, except a run that proposed a plan, whose plan it reviews instead (see `plan`) (`advisor.json`: `models` tried in order, `timeoutMs`, `rubric`, and `enabled`, which defaults to off; `/advisor on` turns it on for a session). A `blocker` or `concern` continues the run once per user input and the agent then writes its final report again in full; nits are drawn on a card the agent does not see. Also an `advise` tool. Leave it out of subagents. |
| `plan` | `/plan [prompt]` toggles plan mode: the agent explores read-only (edit tools work only in the session's `plans/` directory; `worktree` changes and `pr_create`/`pr_merge` are blocked; shell commands are held back by instruction only), writes a standalone plan file, and submits it with the `propose` tool. When the advisor is on, `propose` first shows "Advisor reviewing the plan…" and has it review the plan: blockers and concerns go back to the agent once per user input, nits go on the review card. The review card shows the plan and offers approve and execute here, approve and execute in a new session (pick its model and thinking level), revise with feedback, or edit the plan; `/plan-review` reopens it. |
| `goal` | `/goal <objective>` works the objective to the end: every response that does not call the `goal` tool with `op: "complete"` gets another request from the harness, so a report, a list of options, or a "Needs you" section cannot end the run. `/goal` pauses and resumes, `/goal off` clears, Esc pauses. The hidden prompt tells the agent to do the work rather than narrate it and to ask through the `questionnaire` tool instead of stopping with a question; each continuation states the real context budget, says context is never a stop reason, and quotes the last lines that ended the run so the model answers them instead of repeating them. Completion is the model's call: no cap, no verification command, no token budget. Independent of `plan`: plan mode blocks the edits a goal needs, so `/goal` refuses to start while it is on. |
| `checkpoint` | The `checkpoint` tool records the session's state in five lines (done, next, blocked, where, checks) as a session entry at a phase boundary; `/status` renders it with the checkout's branch and changed paths, and a resumed or forked session opens with it in context instead of re-deriving it. |
| `runlog` | On resume or fork, finds the tool calls in the branch that never got a result and tells the run which call was in flight, with its arguments and whether re-issuing it is safe (a read) or needs a check (a write, a pull request, a worktree change, a shell command). It reads the transcript rather than keeping a second log. |
| `papercuts` | A `papercut` tool for the agent to report harness friction (a tool that is `broken`, a `missing` feature, a `misleading` description or error, or other `friction`); each report is a line in `papercuts.jsonl` in the agent directory with an id, the time, model, cwd, and session file, so a report leads back to its transcript; the subagents load it too. The `papercut-review` skill (`/skill:papercut-review`) clusters open reports, verifies them against the code and transcripts, fixes the approved ones, and records each fix in `papercuts-resolved.jsonl`. |
| `lint` | Appends findings for lines an `edit`/`write` adds: history comments, `TODO`/`FIXME`, debug output. |
| `emphasis` | In interactive replies, draws an icon on the report labels that `prompts/AGENTS.md` names and on links (one for a URL, one for a local path), colors `✓`, `✗`, `→`, and tree lines, and draws bars under a table of one text column and numeric columns that share a unit (adapted from [pi-emphasis](https://github.com/johnlindquist/pi-emphasis), MIT). |
| `turn-time` | Elapsed time while the agent works; the last turn's time as a status the footer draws. |
| `footer` | Replaces pi's footer: model and thinking level, session directory (worktree icon in one), git branch with `*unstaged +staged ?untracked` counts, tokens in and out, cache read and write (write only when a provider reports one), cost, context percent and the model's context window (`25% / 272k`; colored at 50/70/90), subscription windows from `usage` (colored at 50/80), the last turn time, and the statuses of other extensions. One icon per segment (Nerd Font). Only one extension can own the footer. Tokens and cost cover the branch's nested model calls too (advisor, subagents, tools, compaction); `/cost` splits them by source. |
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
  "compactRatio": 0.75,
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

`compactRatio` compacts any model without a chain `compactAt` once a run
settles above that fraction of its context window. The window is the routed
model's, read on each run, so a direct model and every chain fallback get
their own limit. A chain's `compactAt` still wins.
