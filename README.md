# pi-extensions

Extensions for the [pi](https://github.com/earendil-works/pi) coding agent.

| Extension | Purpose |
|---|---|
| `guards` | Blocks permanent installs and git history rewrites in `bash`/`shell` (the user can allow one in a dialog), asks before any tool touches `~/.ssh`, `~/.gnupg`, `~/.config/sops`, `~/Library`, or `/etc`, and masks secrets in tool output. |
| `chains` | Fallback chains as virtual models (`chain/<name>`): per-provider cooldowns shared across processes, retries and usage limits move to the next target, compaction at a per-chain token count, `/chain-reset`. |

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
