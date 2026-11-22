---
name: nixos-change-validation
description: "Nix change validation. Use for .nix edits, flake changes, NixOS or Darwin builds, deployment, activation, or rollback guidance."
---

# NixOS Change Validation

This skill also covers nix-darwin hosts. Read `darwin-rebuild` for `nixos-rebuild` where the host is macOS.

Read `references/activation-and-state.md` before proposing an activation command for a host-affecting change (boot, persistence, secrets, networking, services, or deployment). It covers what `nixos-rebuild test` cannot prove, impermanence and secret failures that appear only at activation, and deploy-rs rollback behavior.

Inspect the flake outputs, module imports, host composition, overlays, package definitions, deployment tooling, state-version policy, and applicable AGENTS.md files before editing.

## Look up

Use the `nix` tool before writing an option or package name from memory:

- `option` with `host` and `path` returns the type, default, description, declaring files, and the host's current value, evaluated from this flake. It covers every module the flake imports (sops-nix, impermanence, hjem, the repository's own) at the pinned nixpkgs, so prefer it to `search` for anything a host already uses.
- `search` finds NixOS packages and options on search.nixos.org for a channel; `versions` gives a package's release history with nixpkgs commits.
- `inputs` lists the flake's inputs with their store paths and reads files inside one, for a module's source.

## Change

- Follow the repository's existing option, module, formatting, and host-ownership patterns.
- Keep evaluation pure where the repository expects it and avoid unnecessary input or lock-file churn.
- Preserve bootability, remote access, persistent state, secret delivery, and rollback capability for host-affecting changes.
- Prefer standard NixOS options and small module composition over custom abstractions.
- Add tests only when they provide useful evidence for changed behavior, using existing conventions. Avoid new helpers, generalized modules, or comments that do not explain a relevant invariant.

## Validate

Run repository commands through the entry point `devshell-preflight` resolves.

Run the narrowest repository-supported evaluation or build that proves the affected output, then broader checks only when justified. Depending on the repository, this may include formatter checks, `nix flake check`, the `nix` tool's `eval`, a host toplevel build, package builds, or deploy-rs checks.

When a change is intended to preserve behavior, prove it: `drv_diff` with the affected hosts compares each toplevel's drvPath in the working tree against `base` (default `HEAD`); `same: true` is the proof. State what the comparison cannot cover. New files count only once `git add` has staged them; `drv_diff` names untracked `.nix` files it could not see.

Keep a check's full output. `shell` writes every command's output to the log file named in its result; pass `tail` for the end and read or grep the log for the error.

Before pushing an input bump or package change, run `dry_run` on the affected outputs. `build` lists what no configured cache has (cache.nixos.org, the repository's own caches); `heavy` marks builds flagged big-parallel or named like a compiler, kernel, or browser, as a hint rather than proof, so read `build` itself too. A heavy or long `build` list means CI will build from source: report it before opening the pull request. `cache` checks a single path against every substituter; garret reports a miss during a slow database read the same as a real miss, so treat its `missing` as unconfirmed. Use the repository's way to prebuild and push if one exists, but ask the user first when the list holds more than a few dozen derivations or a full toolchain; waiting for the upstream cache can be the better choice.

If the Nix daemon, remote builder, required system, cache, or secret is unavailable, report the limitation and do not claim runtime validation.

## Activate safely

Do not activate or deploy unless the user asked for it in this conversation; when they did, do not ask again for the same host and scope. Before advising a reboot or `boot`-then-reboot on a host, check project memory and docs for known boot problems on that host and state them.

Removing a service that owns an impermanence bind mount or a container storage mount can make `switch` fail while stopping that mount unit. Retrying the same deploy does not change the outcome; stop the owning units first or activate with `boot` and a reboot, and say which.

Provide the repository's exact test, switch, deploy, or rollback command and post-activation checks for the changed service, generation, mounts, persistence, networking, and remote access as applicable. Call out changes that require reboot or cannot be safely tested with `nixos-rebuild test`.
