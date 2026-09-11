---
name: orca-ledger
description: >-
  Use Orca's ledger CLI through `orca ledger ...` commands to keep a durable,
  typed record of engineering observations on a project or group: file a bug,
  deferred item, test gap, proposal, or decision with `orca ledger file --type
  <type> ...`, list and show entries with their revision and history, edit
  content or change lifecycle state under an optimistic `--if-revision <n>`
  precondition, revert to an earlier revision, triage what is unreviewed or
  stale with `orca ledger review --json`, and pull legacy BUGS.md,
  DEFERRED.md, TEST_BACKLOG.md, proposals.md, and docs/adr files in with
  `orca ledger import --json`. Use when the user says "orca ledger", "ledger
  entry", "file it in the ledger", "log this in the ledger", "ledger review",
  "ledger triage", "ledger import", or asks about a stale-revision conflict on
  a ledger entry. The ledger lives in the Orca profile, not the git checkout,
  so entries survive worktree deletion and stay visible to sibling worktrees
  of the same project.
---

# Orca Ledger

This discovery stub loads the version-matched guide from the Orca executable used for this session.

Engage Orca's ledger CLI (`orca ledger ...`) whenever an engineering observation needs to
outlive the current worktree: file a bug, deferred item, test gap, proposal, or decision;
list, show, and triage what is already recorded; edit content or change lifecycle state
under an optimistic revision precondition; revert to an earlier revision; and import legacy
BUGS.md, DEFERRED.md, TEST_BACKLOG.md, proposals.md, and docs/adr files. Ledgers live in the
Orca profile rather than the git checkout, so entries survive worktree deletion and stay
visible to sibling worktrees of the same project.

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
ORCA skills get orca-ledger
```

Prefer `--json`. Use the selected executable's `--help` for commands or flags the guide does
not cover. If a command reports that Orca is not running, start it with `ORCA open --json`
and retry. If `skills get` is unknown, explain that updating Orca restores the guide; use
`--help` for read-only discovery and do not guess unsupported commands.
