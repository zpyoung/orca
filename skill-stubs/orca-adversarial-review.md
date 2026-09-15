# Orca Adversarial Review

This file is a discovery stub, not the protocol guide. The full, version-matched workflow is served
by the Orca binary that owns the run directory, CLI schemas, stage prompts, and verdict logic.

Use this skill to drive Orca's CLI when an Orca workspace needs an adversarial review of a diff,
commit, branch, hosted change, file, folder, spec, plan, or prose claim. It writes progress and the
mechanical verdict to Orca's Adversarial Review panel. It never applies fixes.

## Resolve the CLI for this session

Choose the executable once and reuse it:

- Use `ORCA_CLI_COMMAND` when set.
- Otherwise use `orca-dev` when `ORCA_DEV_REPO_ROOT` is set.
- Otherwise use `orca-ide` on Linux outside an Orca-managed terminal. Never run bare `orca` there;
  it normally resolves to the GNOME screen reader.
- Otherwise use `orca`.

`ORCA` below is a placeholder for that executable. Substitute it directly; do not run `ORCA`
literally or create a shell variable. If it fails, report the exact error instead of trying another
binary.

## Load the complete guide

```text
ORCA skills get orca-adversarial-review
```

Read the returned guide before running any review or orchestration command. Do not guess the
pipeline from this stub or use the upstream Python `adversarial-review` skill: only the
version-matched Orca guide drives the CLI and panel correctly. Confirm the runtime with
`ORCA status --json`; this workflow requires an Orca workspace.
