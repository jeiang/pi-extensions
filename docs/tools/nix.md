# nix

Nix lookups, validation, and builds with structured results.

## Use instead of
- `nix eval`, `nix search` → nix eval, search, option
- `nix build`, `nix log | sed` → nix build, log
- `nix path-info -r | grep`, `nix store diff-closures`, `nix why-depends` → nix closure (filter, against, why)
- `nix flake update` → nix flake_update
- `nix derivation show` → nix derivation

## Examples
```js
await tools.nix.drv_diff({ outputs: ["alda", "zakkart"], base: "origin/main" });
await tools.nix.closure({ outputs: ["zakkart"], filter: "^python" });
await tools.nix.flake_update({ input: "nixpkgs" });
```

## Errors
- Untracked .nix files are invisible to the flake until git add.

## Related
run (nix develop, nix run)
