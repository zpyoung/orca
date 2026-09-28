---
name: orca-heimdall
description: >-
  Use `orca heimdall ...` to observe and manage durable Heimdall watchers: list the fleet,
  inspect status, escalations, workers, plans, and debug reports; create objective or
  hosted-review watchers; approve gated actions; answer worker or owner questions; adjust
  budgets and concurrency; and pause, resume, disarm, or permanently remove a watcher. Use
  when the user says "orca heimdall", "Heimdall watcher", "watcher fleet", "PR sitter",
  or asks to create, inspect, steer, or stop an objective or hosted-review watcher.
---

# Orca Heimdall

This discovery stub loads the version-matched guide from the Orca executable used for this session.

Use Orca's `heimdall` CLI to observe and manage the watcher fleet: list and inspect watchers,
create objective or hosted-review watchers, approve or answer escalations, adjust budgets, steer
workers, pause, resume, disarm, or remove a watcher. Management commands can target remote-owned
watchers through the fleet row's recorded owner; create enrolls only on a workspace local to the
selected runtime, so connect directly to another owner rather than relying on a fallback. Start by
reading the full guide before acting.

## Resolve the CLI for this session

Choose the executable once and reuse it for every later command:

- If the `ORCA_CLI_COMMAND` environment variable is set, use its value. Orca exports this
  for managed WSL sessions.
- Otherwise, in a dev checkout whose session exposes `ORCA_DEV_REPO_ROOT`, use `orca-dev`.
- Otherwise, on Linux outside an Orca-managed terminal, use `orca-ide`. Never run bare
  `orca` there — outside Orca's terminals it normally resolves to the
  GNOME Orca screen reader (`/usr/bin/orca`) and starts speech on the user's machine.
- Otherwise, use `orca`.

Below, `ORCA` is a placeholder for the executable you resolved. Substitute it before
running anything; do not create a shell variable or run `ORCA` literally. This works the
same way in POSIX shells, PowerShell, and cmd.exe.

If the selected executable cannot run, report its exact error and stop. Do not fall through
to another executable, which could silently target a different Orca build.

## Load the version-matched guide before running Orca commands

```text
ORCA skills get orca-heimdall
```

Prefer `--json`. Use the selected executable's `--help` for commands or flags the guide does
not cover. If a command reports that Orca is not running, start it with `ORCA open --json`
and retry. If it fails with `runtime_access_denied`, your sandbox blocked the connection:
re-run it with escalated permissions, and do not run `ORCA open` or restart Orca. If
`skills get` is unknown, explain that updating Orca restores the guide; use `--help` for
read-only discovery and do not guess unsupported commands.
