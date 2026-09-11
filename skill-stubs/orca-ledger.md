# Orca Ledger

This file is a discovery stub, not the usage guide. The full, version-matched Orca Ledger
reference is served by the `orca` binary itself — kept out of this file on purpose so it can
never drift from the binary that will actually run your commands.

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

## Load the full guide before running Orca commands

```text
ORCA skills get orca-ledger
```

That prints the complete, version-matched guide for the exact binary that will handle your
next commands — the entry types and their required fields, choosing between a project,
group, or detached ledger, editing under a revision precondition, triage, and import. Read
it first, then run the specific command you need.

Don't guess subcommands or flags from memory or from a cached copy of this stub. They
change between Orca releases, and this file deliberately no longer lists them. Confirm the
app is up with `ORCA status --json` (start it with `ORCA open --json` if needed), and
prefer `--json` for agent-driven calls.

## If an older Orca does not recognize `skills get`

Use this fallback only when the selected binary explicitly reports that `skills get` is an
unknown command. Another failure is not proof of an older binary; report it rather than
guessing or changing executables. For a confirmed pre-guide binary, use only this bounded,
read-only bootstrap to orient. Do not dead-end and do not invent commands:

```text
ORCA status --json
ORCA ledger list --json
ORCA ledger review --json
```

Then tell the user that updating Orca restores the full, version-matched guide via
`ORCA skills get orca-ledger`. Beyond these commands, ask the user rather than guessing a
command surface this older binary may not support.
