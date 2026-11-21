---
name: devshell-preflight
description: Diagnose a repository's Nix development environment when a command fails inside it, for example a missing toolchain or a broken flake devShell. Commands already run inside the devshell automatically; do not load this skill to resolve the environment before ordinary work.
---

# Devshell Preflight

The `shell` tool and `!` commands already run inside the repository's
devshell: the nearest `devenv.nix`, else `flake.nix` devShell, else
`shell.nix`, cached per lock file. direnv and `.envrc` play no part in it.
Use this skill only when a command fails because of that environment.

## Diagnose

1. Identify the source the session uses: the nearest directory, from the
   working directory upward, that holds `devenv.nix`, `flake.nix`, or
   `shell.nix`.
2. Reproduce the failure with the plain entry point to see its own error:
   `devenv shell -- <cmd>` (or `nix run nixpkgs#devenv -- shell -- <cmd>`),
   `nix develop -c <cmd>`, or `nix-shell --run '<cmd>'`.
3. Common causes:
   - The devshell fails to evaluate: the command then ran without it and
     its output starts with "devshell failed".
   - `devenv.nix` without `flake.nix`: `nix develop` fails with "not part
     of a flake"; that is the wrong entry point, not a broken repository.
   - The tool is not in the devshell: report it; add it to the repository's
     environment only when the task allows that change.
   - The environment comes only from `.envrc` (no Nix file): the session
     does not load it. Run the command as `direnv exec . <cmd>` when the
     user has allowed that `.envrc`; never run `direnv allow` yourself
     without being asked.

## One-off tools

Use temporary Nix tooling such as `nix shell nixpkgs#<pkg> -c <cmd>`, never a
permanent installation. A Python library needs the wrapper form:
`nix-shell -p "python3.withPackages(p: [p.pyyaml])" --run '<cmd>'`.

Do not run checks in another checkout and claim they validated the changed
files. State the limits of any substitute.
