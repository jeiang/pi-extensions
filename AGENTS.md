# AGENTS.md

Extensions for pi (`@earendil-works/pi-coding-agent`), one directory per
extension under `extensions/`, each with an `index.ts` default export. pi
loads the TypeScript directly; there is no build step. cornn-flaek consumes
this flake's `packages.default` and lists the extensions in pi's settings.

- Check: `nix develop -c npm run check` (typecheck and tests). `nix build`
  runs the same check.
- Tests use pi's SDK in process with scripted providers (`test/harness.ts`);
  they never call a real model.
- Pin `@earendil-works/pi-coding-agent` to the pi version cornn-flaek runs.
  Runtime dependencies go in `dependencies`; everything pi supplies stays in
  `devDependencies`.
- Conventional Commits.
