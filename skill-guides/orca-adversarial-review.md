---
name: orca-adversarial-review
description: >-
  Drive Orca's CLI to adversarially review a diff, commit, branch, hosted change,
  file, folder, spec, plan, or prose claim. Requires an Orca workspace and a
  running Orca runtime. Use for "adversarial review", "red team this", "attack
  this", "find flaws", "tear this apart", or "poke holes in this" when the
  result must appear in Orca's Adversarial Review panel.
---

# Orca Adversarial Review

Drive one Orca-owned review run from capture through its deterministic verdict. The model stages
only propose or adjudicate findings; `ORCA review` owns capture, chaining, evidence checks, and the
verdict. Never edit the reviewed artifact or apply fixes while driving the run.

## Resolve the CLI for this session

Choose the executable once and reuse it for every later command:

- If the `ORCA_CLI_COMMAND` environment variable is set, use its value. Orca exports this
  for managed WSL sessions.
- Otherwise, in a dev checkout whose session exposes `ORCA_DEV_REPO_ROOT`, use `orca-dev`.
- Otherwise, on Linux outside an Orca-managed terminal, use `orca-ide`. Never run bare
  `orca` there — outside Orca's terminals it normally resolves to the
  GNOME Orca screen reader (`/usr/bin/orca`) and starts speech on the user's machine.
- Otherwise, use `orca`.

Below, `ORCA` is a placeholder for the executable you resolved. Substitute it before running
anything; do not create a shell variable or run `ORCA` literally. This works the same way in POSIX
shells, PowerShell, and cmd.exe.

If the selected executable cannot run, report its exact error and stop. Do not fall through to
another executable, which could silently target a different Orca build.

## Load the version-matched guide

```text
ORCA skills get orca-adversarial-review
```

Read that output before running the pipeline. Do not drive a review from a cached guide: the CLI,
stage schemas, and bundled guide version together. Confirm the runtime with `ORCA status --json`.
This workflow requires an Orca workspace; if status or workspace resolution fails, report the
structured error rather than substituting the upstream Python skill or raw Git commands.

Use `--json` on every Orca command. Each `review` command prints exactly one JSON object. Exit 1 is
a documented domain result for `prepass`, `select-model`, and some verdicts; it is not automatically
a crashed command. Exit 2 is a mechanical failure and must not be flattened into a review result.

## Inputs and run identity

The launch prompt supplies the run ID and selected target, profile, depth, author family, and
optional reviewer. Use those values exactly. If this guide was invoked outside the launch dialog,
create the run first and retain the returned ID:

```text
ORCA review run-create --json
```

Do not invent a run ID. Do not reuse an earlier run directory. Use the exact run ID with every
later `review` command.

Resolve the fixed artifact before dispatching anything:

```text
ORCA review resolve --run <run-id> --target <target> --profile <profile> [--criteria-file <path>] --json
ORCA review prepass --run <run-id> --json
ORCA review select-model --run <run-id> --author-family <family> [--reviewer <agent>] --json
```

Treat `prepass` exit 1 as evidence: failed checks become findings, and `could-not-run` can lead to
`NOT_REVIEWABLE`. Treat `select-model` exit 1 as a recorded unresolved selection and continue to the
gate; do not claim that no reviewer means a clean run. Stop and run `review run-fail` after any exit
2 that cannot be corrected by fixing the command's literal input.

`resolve` captures the artifact. From that point until the final gate:

- do not edit, format, stage, commit, checkout, reset, or generate files in the reviewed artifact;
- do not run extra project commands outside the recorded pre-pass;
- do not let a reviewer edit files;
- do not bypass a staleness refusal.

## Dispatch one model stage

For each required stage, repeat this complete lifecycle. Never reuse a reviewer's context for a new
stage.

1. Compose the prompt mechanically:

   ```text
   ORCA review stage-prompt --run <run-id> --stage <promote|refute|tiebreak|quick> --json
   ```

2. Use the returned `.prompt` verbatim as the orchestration task spec. Add no rationale, commit
   message, PR/MR description, prior chat, implementation history, or summary.

   ```text
   ORCA orchestration task-create --spec <exact-prompt> --json
   ORCA orchestration worker-start --task <task-id> --worktree current --agent <selected-agent> --json
   ```

   Save the complete `worker-start` JSON unchanged as
   `.orca-review/runs/<run-id>/stages/<stage>.<attempt>.receipt.json`. The effective launch fields,
   not your requested label, are review provenance.

3. Wait for the exact dispatch. A timeout is a checkpoint, not stage failure:

   ```text
   ORCA orchestration check --wait --types worker_done,escalation,question --timeout-ms 900000 --json
   ORCA orchestration worker-read --dispatch <dispatch-id> --json
   ORCA orchestration worker-release --dispatch <dispatch-id> --json
   ORCA orchestration check --ack <delivery-id> --json
   ```

   Process the whole delivery before acknowledging it. Release only after accepted `worker_done`.
   Do not release on a timeout, heartbeat, question, or escalation.

4. Save the reviewer's exact final JSON payload under the run directory:

   | Stage      | Output path               |
   | ---------- | ------------------------- |
   | `quick`    | `quick.findings.json`     |
   | `promote`  | `promote.findings.json`   |
   | `refute`   | `refute.judgments.json`   |
   | `tiebreak` | `tiebreak.judgments.json` |

   An empty JSON array is valid. No output is a crash. You may unwrap one leading ` ```json ` fence;
   otherwise do not repair, complete, summarize, or reinterpret malformed JSON.

### Dispatch failure rule

For empty, malformed, truncated, or failed stage output:

1. Retry the same stage once in a fresh terminal and fresh context, linking the attempt:
   `ORCA orchestration worker-start --task <new-task-id> --retry-of <dispatch-id> --worktree current --agent <same-agent> --json`.
2. If it fails again, move to the next available reviewer returned by the selection ladder. Create a
   new task and fresh dispatch for every candidate; never silently substitute an agent.
3. If the ladder is exhausted, record the failure and stop:
   `ORCA review run-fail --run <run-id> --json`.

Never hand-repair model JSON, skip a required stage, reuse a settled dispatch, or call the gate with
a predecessor from another attempt.

## Pipeline shapes

### Quick

Quick is one self-refuting dispatch and always has reduced independence.

```text
stage quick -> save quick.findings.json
ORCA review gate --run <run-id> --depth quick --json
ORCA review manifest --run <run-id> --json
```

Pass the whole quick object through the gate. Do not drop its `suppressed` entries or turn an empty
response into `[]`.

### Standard

```text
stage promote -> save promote.findings.json
ORCA review claims --run <run-id> --findings .orca-review/runs/<run-id>/promote.findings.json --json
stage refute -> save refute.judgments.json
ORCA review merge --run <run-id> --findings .orca-review/runs/<run-id>/claims.json --judgments .orca-review/runs/<run-id>/refute.judgments.json --stage refute --json
ORCA review gate --run <run-id> --depth standard --json
ORCA review manifest --run <run-id> --json
```

`claims` assigns IDs and withholds non-defect records. Do not synthesize IDs yourself. `merge`
requires exactly one judgment for every staged claim.

### Deep

Run the standard promote, claims, refute, and refute merge, then call the first deep gate:

```text
ORCA review gate --run <run-id> --depth deep --json
```

If `contested[]` is empty, proceed to `manifest`. If it is non-empty, the gate is deliberately
verdict-less and the run is still in flight:

```text
stage tiebreak -> save tiebreak.judgments.json
ORCA review merge --run <run-id> --findings .orca-review/runs/<run-id>/merge.refute.json --judgments .orca-review/runs/<run-id>/tiebreak.judgments.json --stage tiebreak --json
ORCA review gate --run <run-id> --depth deep --json
ORCA review manifest --run <run-id> --json
```

Tiebreak must use a third family when available. It judges every contested finding and no others;
`contested` is not a valid final tiebreak disposition. Never call `manifest` while contested
findings remain.

## Never stage to a reviewer

Only the composed `stage-prompt` output may become the task spec. Never append or separately send:

- commit messages, branch names chosen for narrative meaning, PR/MR descriptions, or review comments;
- design rationale, implementation notes, the author's explanation, chat history, or session transcript;
- the author's claimed test results, confidence, conclusion, or suggested findings;
- dismissed-finding reasons;
- previous model reasoning or hidden chain-of-thought;
- a hand-written summary of the artifact, criteria, findings, or evidence;
- files outside the captured artifact, or instructions to edit/write/apply patches.

Criteria is allowed only because `resolve` captured the user's criteria verbatim. In closure rounds,
only the mechanically composed prompt may add prior protocol output, and it withholds dismissal
reasons. Reasoning already inside the artifact necessarily travels with the artifact; do not add a
second copy from author context.

## Finish and report

`gate` uses verdict exit codes: `0 PASS`, `1 NEEDS_FIXES`, `3 CRITICAL_ISSUES`, and
`4 NOT_REVIEWABLE`. Handle all four by name. `NOT_REVIEWABLE` is not success, and `PASS` means only
that no unresolved finding met the blocking bar in this captured scope.

A completed run must have `manifest.json`. Report the manifest's verdict, independence, depth,
profile, limitations, questions, advisory count, unreviewed paths, and run ID without inventing a
clean-bill-of-health summary. Findings remain advisory; do not apply them during the review run.
