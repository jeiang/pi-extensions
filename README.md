# pi-extensions

Extensions for the [pi](https://github.com/earendil-works/pi) coding agent.

| Extension | Purpose |
|---|---|
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
