---
name: papercut-review
description: Review the papercuts agents reported about the harness, verify them, fix the real ones, and mark them resolved.
disable-model-invocation: true
---

# Papercut review

Agents report harness friction with the `papercut` tool. Each report is a
line in `papercuts.jsonl` in the agent directory: `id`, `time`, `kind`
(`broken`, `missing`, `misleading`, `friction`), `tool`, `text`, `model`,
`cwd`, and `session` (the transcript file, absent for unsaved sessions).
Resolutions are lines `{"resolved": "<id>", "time": "...", "fix": "..."}` in
`papercuts-resolved.jsonl` beside it.

Volume is the signal: nine reports of one problem outrank one vivid
report. Each report is a hypothesis written mid-task, not a finding.

## 1. Snapshot

Load the open reports in one codemode script:

```js
const dir = (await sh('printf %s "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"')).trim();
const read = async (f) => {
  try { return (await tools.read_text({ path: `${dir}/${f}` })).text.split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};
const resolved = new Set((await read("papercuts-resolved.jsonl")).map((r) => r.resolved));
const open = (await read("papercuts.jsonl")).filter((r) => !resolved.has(r.id));
const groups = {};
for (const r of open) (groups[`${r.tool ?? "?"} · ${r.kind}`] ??= []).push(r);
return Object.entries(groups)
  .map(([key, rs]) => ({ key, count: rs.length, days: new Set(rs.map((r) => r.time.slice(0, 10))).size, cwds: new Set(rs.map((r) => r.cwd)).size, reports: rs.map(({ id, time, model, session, text }) => ({ id, time, model, session, text })) }))
  .sort((a, b) => b.count - a.count);
```

Done when you hold every open report.

## 2. Cluster and rank

The `tool` string is free text, so merge groups by the underlying problem,
not the label: "codemode run()" and "codemode" may be one problem, and one
label may hide two. Rank clusters by count, then days spanned, then
distinct `cwd`s. Within a rank, `broken` and `misleading` come first: a
tool that returns a plausible wrong answer costs more than one that fails
loudly.

Done when every open report belongs to exactly one cluster.

## 3. Verify

For each cluster, from the top, check the stated cause against the code,
prompt, or config it blames:

- Read the transcript around the report: in the `session` file, find the
  `papercut` tool call and read the calls before it. The agent may have
  misused a working tool, and then the fix is the description or prompt
  that misled it.
- Reproduce a `broken` report where you can.
- Give each cluster a verdict: **real** (cause confirmed, with the file
  and line), **misuse** (the tool works; name the wording that misled the
  agent), or **noise** (no harness problem).

Done when every cluster has a verdict backed by evidence you looked at.

## 4. Report and fix

Show the user a table: cluster, count, days, verdict, proposed fix and
where it lands. Fixes land where the harness lives:

- `pi-extensions`: tool code under `extensions/`, tool descriptions,
  `prompts/AGENTS.md`, `agents/`, `skills/`.
- `cornn-flaek` (`modules/agents/pi/`): settings, loaded extensions,
  `loadout.json`, chains, advisor models.
- `agent-skills`: the shared skills.

Fix the root once, in the always-loaded layer when the problem is
wording. Fix only the clusters the user approves, each as its own commit
in a worktree of the repository it lands in.

## 5. Resolve

Once a fix is committed, resolve every report its cluster holds, not only
the newest: read `papercuts-resolved.jsonl` (create it if absent), append
one line per report id with `fix` naming the commit or pull request, and
write it back. Leave `papercuts.jsonl` untouched; agents append to it
concurrently. Mark **noise** clusters resolved with `fix` stating why.

Done when every report in a fixed or noise cluster has a resolution line.
