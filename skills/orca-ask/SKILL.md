---
name: orca-ask
description: >-
  Use `orca ask` to ask the user a question and block until they answer it —
  select/multiselect/text/number/date/confirm questions with a structured JSON
  answer envelope back, for a genuine human decision the agent cannot
  determine by reading code, config, or tests. Not for permission to proceed,
  and not the same as `orca orchestration ask` (worker-to-coordinator agent
  messaging inside an orchestration run — see the orchestration skill for
  that). Triggers include "orca ask", "ask the user", "ask a question and
  wait for the answer", or needing the user to choose between options,
  confirm a decision, or supply a non-secret value.
---

# Orca Ask

This file is a discovery stub, not the usage guide. The full, version-matched Orca ask
reference is served by the `orca` binary itself — kept out of this file on purpose so it
can never drift from the binary that will actually run your commands.

Engage `orca ask` whenever you need a genuine human decision you cannot determine by
reading code, config, or tests — not for permission to proceed, and not the same as
`orca orchestration ask`, which is worker-to-coordinator agent messaging inside an
orchestration run (see the orchestration skill for that). Triggers include "orca ask",
"ask the user", "ask a question and wait for the answer", or needing the user to choose
between options, confirm a decision, or supply a non-secret value.

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
ORCA skills get orca-ask
```

That prints the complete, version-matched guide for the exact binary that will handle your
next commands — the register/wait/cancel commands, the register → wait loop, exit codes,
the question schema, escape hatches, credential refusal, and answer shapes. Read it first,
then run the specific command you need.

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
```

There is no safe read-only substitute for `ask` itself — registering one is a real,
user-visible side effect, and an older binary may not have the command at all. Do not
fall back to `orca orchestration ask`; it is a different tool for worker-to-coordinator
messaging, not for asking the human user.

Then tell the user that updating Orca restores the full, version-matched guide via
`ORCA skills get orca-ask`. Beyond `status`, ask the user rather than guessing a command
surface this older binary may not support.
