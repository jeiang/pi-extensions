# AGENTS.md

Extensions for pi (`@earendil-works/pi-coding-agent`), one directory per
extension under `extensions/`, each with an `index.ts` default export. pi
loads the TypeScript directly; there is no build step. cornn-flaek consumes
this flake's `packages.default` and lists the extensions in pi's settings.
`prompts/AGENTS.md` is pi's global instruction file, `agents/` holds the
subagent definitions, and `skills/` the skills written for pi; cornn-flaek
links all three into `~/.pi/agent`.

- Check: `nix develop -c npm run check` (typecheck and tests). `nix build`
  runs the same check.
- Tests run under Bun (`bun test`), like the compiled pi binary: the
  `@oh-my-pi/pi-natives` loader needs Bun. They use pi's SDK in process with
  scripted providers (`test/harness.ts`) and never call a real model.
- Pin `@earendil-works/pi-coding-agent` to the pi version cornn-flaek runs.
  Runtime dependencies go in `dependencies`; everything pi supplies stays in
  `devDependencies`.
- On a pi bump, diff pi's `dist/extensions/codemode` against
  `extensions/codemode`, which captures the built-in tool, replaces its
  guideline, and inserts helpers after the `// @options` line;
  `test/codemode.test.ts` fails if the capture breaks.
- Conventional Commits.
