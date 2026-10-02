---
name: orca-heimdall
description: >-
  Use `orca heimdall ...` to observe and manage durable Heimdall watchers: list the fleet, inspect
  status, escalations, workers, plans, and debug reports; create objective or hosted-review
  watchers, and create and run saved pipelines; approve gated actions; answer worker or owner
  questions; adjust budgets and concurrency; pause, resume, disarm, or permanently remove a watcher.
  Use when the user says "orca heimdall", "Heimdall watcher", "watcher fleet", "pipeline",
  "PR sitter", or asks to create, inspect, steer, or stop a watcher.
---

# Orca Heimdall

Heimdall watchers are durable reconcilers. The kernel reads the workspace or review, chooses an
action deterministically, then applies capability, approval, budget, and safety gates before an
action can run. Use the CLI as an **observe → decide → act** loop: inspect the current fleet and
watcher evidence first, decide only from that evidence, then issue the narrowest command.

`ORCA` is a placeholder for the executable you resolved in the stub. Substitute it before running
commands; do not create a shell variable or run `ORCA` literally. Prefer `--json` when an agent
needs to read the result. `--json` uses the standard Orca CLI envelope; inspect the `result` as well
as process success, because refusals and indeterminate outcomes are returned as structured results.

## Observe, decide, act

### Observe

```text
ORCA heimdall list [--kind objective|hosted-review] [--worktree <selector>] [--json]
ORCA heimdall show <watcherId> [--json]
ORCA heimdall objective <watcherId> [--json]
ORCA heimdall debug <watcherId> [--out <path>] [--json]
```

- `list` is the fleet overview: watcher id, kind, state/phase, workspace, contact, and paused state.
  `--kind` and `--worktree` narrow the rows; omit them for the fleet. A remote contact that is
  `unverifiable` means the owner could not be confirmed, not that it is safe to target a local copy.
- `show` reads status and park reason, open escalations, and workers. It is the source for the exact
  escalation id, worker-question message id, and worker dispatch id needed by steering commands.
- `objective` reads an objective watcher's plan, tasks, and landing state. It is not valid for a
  `hosted-review` watcher.
- `debug` returns the bounded debug report as JSON even without `--json`; `--out` also writes that
  report to a path on the machine running the CLI. Review preserved paths and free-text details
  before sharing the report.

### Decide

Treat the status, decision trace, open escalations, and live worker evidence as the current facts.
A watcher in `held` state may be obeying a safety interlock, not failing. Read its hold reason before
changing settings or retrying an action.

Capability modes determine whether an action is permitted:

| Mode    | Effect                                                                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | The action is never taken. The gate reports `capability-off` without opening an escalation; the watcher can propose it again on later ticks. |
| `gated` | The action waits for explicit approval of its exact action scope.                                                                            |
| `on`    | The action can run unattended when its other gates pass.                                                                                     |

Approval is scoped to the action and the evidence/content it was prepared for. Approving one
escalation does not grant blanket authority for later content. Use the escalation id shown by
`show`; the CLI retrieves its approval scope itself. Never construct or guess an approval scope.

### Act

Use only the matching action for the evidence you observed:

```text
ORCA heimdall approve <watcherId> <escalationId> [--choice <choice>] [--comment <text>] [--extend-minutes <n>] [--json]
ORCA heimdall answer <watcherId> <messageId> --body <text> [--json]
ORCA heimdall answer-escalation <watcherId> <escalationId> --body <text> [--json]
ORCA heimdall budget <watcherId> [--hours <n|none>] [--turns <n|none>] [--json]
```

- `approve` approves the exact pending action scope on that escalation.
- `answer` replies to a pending worker question. Take the message id from `show` and provide the
  answer as `--body`.
- `answer-escalation` supplies the operator's response to the exact owner escalation. It requires a
  host that supports `heimdall.watcher-answer-escalation.v1`; the body must fit the server's size
  limit. This is not the same as approving an action.
- `budget` adjusts the active-time limit (`--hours`) and/or turn limit (`--turns`). `none` means
  unlimited. Omitted dimensions remain unchanged. If a watcher parked because a budget was spent,
  raise that budget before trying `resume`.

Lifecycle and worker controls:

```text
ORCA heimdall pause <watcherId> [--json]
ORCA heimdall resume <watcherId> [--json]
ORCA heimdall disarm <watcherId> [--json]
ORCA heimdall rm <watcherId> [--json]
ORCA heimdall stop-worker <watcherId> <dispatchId> [--json]
ORCA heimdall set-concurrency <watcherId> <maxConcurrency> [--json]
```

- `pause` waits for the in-flight tick and keeps the enrollment. `resume` resumes a paused or
  automatically parked watcher; it refuses while the budget is exhausted or a worker question is
  open. Answer the question or increase the budget first.
- `disarm` stops the current enrollment generation but preserves the watcher record and audit
  ledger. It cannot be undone by `resume`; a later `create` can re-arm the stable record.
- `rm` permanently deletes the watcher and its stored history. It does **not** stop worker
  terminals. Prefer `disarm` when you may need the history; `rm` requires the host capability
  `heimdall.watcher-delete.v1` and is destructive.
- `stop-worker` needs the exact dispatch id and a verifiable process identity. Check `show` before
  issuing it; it stops that worker, not the watcher.
- `set-concurrency` is for objective watchers. Lowering the cap lets active dispatches finish;
  raising it applies on the next tick. Folder workspaces remain capped at 1.

There is no `wait` command. Heimdall advances on watcher pulses; inspect `list` or `show` again to
observe a later state.

## Create a watcher

```text
ORCA heimdall create objective --objective <text> [--worktree <selector>] [options] [--spec <json|@file>] [--json]
ORCA heimdall create hosted-review [--worktree <selector>] [options] [--spec <json|@file>] [--json]
```

The default worktree selector is `active`, resolved from the CLI's local working directory.
On a paired runtime, pass an explicit selector for a workspace local to that runtime; the client
directory cannot identify a server workspace. SSH- or other-runtime-owned workspaces are refused
without fallback. Connect directly to the owning runtime to create there. Hosted-review creation
requires a Git worktree with an open, supported PR/MR on its current branch; the host derives
the branch, provider, review number, and review URL from that worktree and the forge.

Both kinds accept:

- `--hours <n|none>` and `--turns <n|none>` set active-time and turn budgets.
- Repeatable `--cap <key>=<off|gated|on>` overrides a capability. Objective keys are `plan`,
  `implement`, `review`, `check`, and `land`; hosted-review keys are `updateBranch`,
  `resolveConflicts`, `fixChecks`, and `merge`. The CLI validates the key set for the selected kind.
- `--owner claude` with optional `--owner-model <model>` and `--owner-effort <effort>` configures
  the long-lived owner agent and sets owner interventions to `gated`. Owner enrollment requires
  `heimdall.enroll-owner.v1`; only `claude` has the required resumable structured session in this
  slice.

### Objective options and defaults

Objective-specific options:

- `--objective <text>` or `--objective-file <path>` supplies the required objective text; use one.
  `--objective-file` reads UTF-8 text from a path relative to the current directory.
- `--plan-file <path>` reads an existing UTF-8 plan from a path relative to the current directory
  (up to 65,536 characters).
- `--tier express|standard|full` and `--landing-bar files-on-disk|committed-local-branch|pushed-ref|hosted-review|merged`.
- `--max-concurrency <n>` sets the worker cap.
- Repeatable `--territory <glob>` declares writable workspace paths; the default is `**` (the whole
  workspace). Use narrow globs deliberately.
- Repeatable `--role-agent <role>=<agent>` selects agents for `planner`, `implementer`, `reviewer`,
  or `integrator`.
- Repeatable `--gate <name>=<command>` adds a check with a default timeout of 1,800 seconds.
- `--no-lanes` disables objective task lanes.

Defaults match the objective enrollment form: `standard` tier, `files-on-disk` landing bar, maximum
concurrency 3, lanes enabled, whole-workspace territory (`**`), no preselected role agents or gates,
4 active hours, and 40 turns. With the default landing bar, capability modes are `plan: gated`,
`implement: on`, `review: on`, `check: on`, and `land: on`. For any other landing bar, `land` defaults
to `gated`; the other four defaults stay the same. Use repeatable `--cap <key>=<off|gated|on>` to
narrow or widen the default capability modes.

A complete `--spec` fragment can set the full objective payload and all capability and budget values
that are not workspace-derived. For this example, `active` must resolve to a Git worktree:

```json
{
  "budget": { "wallClockActiveMs": 14400000, "turns": 40 },
  "capabilities": {
    "plan": "gated",
    "implement": "on",
    "review": "on",
    "check": "on",
    "land": "on"
  },
  "kindPayload": {
    "objectiveText": "Add integration coverage for the account export flow",
    "tier": "standard",
    "landingBar": "files-on-disk",
    "lanesEnabled": true,
    "maxConcurrency": 3,
    "writeTerritory": ["**"],
    "roleAgents": {},
    "sitterOverrides": {},
    "gates": []
  }
}
```

Save it as `objective.json` and run:

```text
ORCA heimdall create objective --objective "Add integration coverage for the account export flow" --worktree active --spec @objective.json --json
```

The CLI resolves the selected workspace and fills `repoId`, `worktreeId`, and, for objective
payloads, `workspaceKind`; do not copy ids from another watcher or pass workspace-derived fields in
the spec. For a folder, the CLI uses `workspaceKind: "folder"` and caps concurrency at 1. Optional
payload fields such as `existingPlan`, `roleLaunch`, or `sitterOverrides` may be supplied through
`--spec`. Flags and the partial `EnrollInput` are combined, with explicit flags taking precedence.

### Hosted-review options and defaults

Hosted-review-specific options:

- `--branch-update merge-base-update|rebase` selects the branch update method.
- `--merge-method merge|squash|rebase|default` selects a merge method; `default` follows the
  provider repository setting.

For hosted-review `--spec`, set `kindPayload.mergeCheckScope` to `"all"` or `"required"`; omitted
values default to `"all"`. `"all"` waits for every current-head check, while `"required"` uses only
checks required by branch rules.

`branch`, `provider`, `reviewNumber`, and `reviewUrl` are optional input candidates. A capable host
derives the authoritative values from the selected worktree and forge; candidate values do not
override or become persisted identity.

Defaults are all four hosted-review capabilities (`updateBranch`, `resolveConflicts`, `fixChecks`,
`merge`) set to `off`, 4 active hours, unlimited turns, `merge-base-update` for branch updates,
`all` for merge-check scope, and the provider's default merge method. The host must advertise the
hosted-review derived-payload runtime capability. If it does not, update and restart that Orca
runtime before retrying; including candidate identity values in `--spec` does not bypass the
capability gate.

The check-scope capability `heimdall.hosted-review-check-scope.v1` is required for `"all"`. If an
older runtime does not advertise it, the CLI refuses an all-scope enrollment rather than silently
dropping or changing the requested scope. `"required"` remains compatible: the CLI omits that field
for the old runtime, preserving its legacy behavior. Update and restart the runtime to use `"all"`.

This complete spec fragment selects a conservative sitter on a Git worktree with an open review:

```json
{
  "budget": { "wallClockActiveMs": 14400000, "turns": null },
  "capabilities": {
    "updateBranch": "off",
    "resolveConflicts": "off",
    "fixChecks": "off",
    "merge": "off"
  },
  "kindPayload": {
    "branchUpdateMode": "merge-base-update",
    "mergeMethod": null
  }
}
```

Save it as `hosted-review.json` and run:

```text
ORCA heimdall create hosted-review --worktree <git-worktree-selector> --spec @hosted-review.json --json
```

`--spec` accepts inline JSON or `@path/to/file.json`; relative file paths resolve from the current
directory. It is a strict partial input with `kindPayload`, `capabilities`, `budget`, and optional
`owner` fields; the create subcommand selects the kind. Omit workspace identity and `workspaceKind`,
which the CLI resolves from the selector. Explicit flags win when a field appears in both places.
Use only one kind per create command.

## Pipelines

A pipeline is a saved version-1 YAML graph executed as a Heimdall watcher. The built-in
`builtin:objective` and `builtin:pr-sitter` pipelines are read-only; duplicate one to customize it.

| Scope      | Reference                                | Files                                                                       |
| ---------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| Built-in   | `builtin:objective`, `builtin:pr-sitter` | Shipped with Orca; no workspace file.                                       |
| Repository | Bare id such as `bugfix`                 | `.orca/pipelines/<id>.yaml` and `.orca/pipelines/<id>.layout.json`.         |
| Personal   | `user:<id>`                              | `<profile>/pipelines/<id>.yaml` and `<profile>/pipelines/<id>.layout.json`. |

Personal pipelines live on the client profile and are not synced to an account. Repo and personal
ids do not shadow one another. An id is a lowercase slug (`[a-z][a-z0-9-]{0,62}`) and must match
the YAML filename. The JSON layout sidecar stores canvas positions; it does not define graph logic.
The CLI accepts repo ids, scoped `user:` and `builtin:` references, and repository pipeline paths:
`.orca/pipelines/<id>.yaml` or the `pipelines/<id>.yaml` alias. An absolute path must stay inside
the selected worktree. Use `user:<id>` to select a personal pipeline.

The YAML declares `version: 1`, `id`, `name` and a non-empty `nodes` list. Inputs are typed
`text`, `number` or `boolean` values; `task` is an implicit required text input unless declared.
Dependencies are on the target node as `after:`; there is no top-level edge list. The node types
are Agent, Check, Script, Decision, Loop, Swarm, Merge, Human gate, Land, Objective and PR sitter.
An Objective node must be the only node; a PR sitter needs a Land predecessor and a Git workspace.

`Check` runs a shell command and passes or fails on its exit status. `gate` means only the Human
gate: it pauses a branch for an operator. An Objective node's `checks:` are shell checks, not Human
gates. A Human-gate approval also does not grant a capability.

`Merge` applies completed Swarm child work in dependency order under the `integrate` capability. If
an owned child worktree still conflicts, Heimdall dispatches a private per-child resolver using the
`agent` capability. It must report `resolved: true`, and Orca also verifies that Git has no unmerged
paths or conflict markers and that protected pipeline files are unchanged. The report alone never
applies the child: Merge proposes a fresh `integrate` action through the normal capability gate
(gated by default, unless the run starter chose another grant). Shared or folder children have no
private worktree, so their conflicts escalate; previously applied children remain applied.

This minimal graph uses the implicit `task` input and declares one optional number input:

```yaml
version: 1
id: bugfix
name: Bugfix
inputs:
  priority:
    type: number
    default: 2
nodes:
  - id: fix
    type: agent
    harness: codex
    prompt: Fix $run.inputs.task
  - id: check
    type: check
    command: git diff --check
    after:
      - fix
```

### Author, validate, and save

The canvas Graph view edits the graph. YAML view is a read-only preview that reflects the current
draft; edit YAML with an external editor. Save writes the YAML and layout even when the graph is
empty or invalid, so unfinished work is preserved. Validate is shared by the canvas, run form, CLI
and host. Run stays disabled until validation is clean. If the canvas has unsaved edits, choose
Save and run or Cancel; a run always resolves the saved file, never an unsaved draft. When replacing
a syntactically broken source from the canvas would rerender the file, confirm the replacement
explicitly.

Repository and folder workspace files live under `.orca/pipelines/`; folder workspaces do not edit
`.gitignore`. Land, Merge and PR sitter are Git-only; a Swarm configured with `worktree: own` is
also unavailable in a folder.

On a new repository pipeline save, Orca checks whether Git ignores its YAML. If a root `.gitignore`
contains the exact bare `.orca` entry (the Orca issue-command rule), auto-tracking rewrites that
entry as `.orca/*` and adds `!.orca/pipelines/`; other entries are not auto-edited. If Git still
ignores the file, the canvas offers an explicit Re-include pipelines action: only after that click
can exact `.orca/` rules be changed to `.orca/*` and the exception added. Other patterns may still
keep the file ignored; if so, save a personal copy instead. Built-ins and personal files do not edit
the repository `.gitignore`.

During a run, `.orca/pipelines/**` is protected from Agent workers (including Swarm children) and
PR-sitter workers. A detected change is rejected like an out-of-territory write rather than
published.

### Snapshot and workspace ownership

Every pipeline run is pinned to the saved graph's scope, id and content hash. Custom pipeline runs
keep their source in the pipeline payload; repo/personal copies keep the original source text. For
a copied Objective or PR sitter, pin/source metadata travel beside the unchanged native watcher
payload. The host validates the source, hash, id, route and settings before enrollment or re-arm,
stores the original copy, and uses it for run identity and later reads—not just display. It never
substitutes the current file or a built-in. Later file edits affect new runs only; there is no
live-run upgrade. Re-arming a custom `pipeline` watcher cannot change its pin identity,
document/source or run inputs. A copied repo/personal Objective/PR-sitter watcher also cannot
change its pin, source, native settings or run inputs; capability and budget changes remain allowed.
After the prior watcher is terminal, use a new run for a different source or inputs. An older host
that cannot preserve required source-bearing pin data refuses enrollment; built-in display pins
remain strip-safe.

A personal source is read on the client and sent with enrollment; the execution host never reads the
client profile. A paired runtime owns the run and continues after the UI client disconnects.
For a direct-SSH workspace, the engine runs in the desktop client: disconnection pauses the run,
running agents stay live, and reconnect resumes it. The pipeline CLI create path accepts only a
workspace local to the runtime it calls; it refuses SSH and other-runtime-owned workspaces rather
than routing or falling back.

The Run graph is read-only and shows node state, elapsed time, attempts or loop rounds, and turns.
When present, a validated Agent report summary is stored separately from declared node outputs; it
is never substituted for an output value.

### Create a pipeline run from the CLI

```text
ORCA heimdall create --pipeline <ref|path> --spec <task text> [--worktree <selector>] [--input name=value]... [--cap name=mode]... [--hours <n>] [--turns <n>] [--owner <agent>] [--owner-model <m>] [--owner-effort <e>] [--json]
```

`--worktree` defaults to `active`. `--spec` is plain task text for the required `task` input (or
Objective text when the graph is a sole Objective); it is not the JSON `--spec` used by the
Objective and hosted-review create leaves. Repeat `--input name=value` for other declared inputs:
defaults are applied, unknown names and missing required values refuse before enrollment. Text values
remain strings, numbers must be finite, and booleans must be exactly `true` or `false`. Do not use
`--input task`; `--spec`
owns that value.

Repeat `--cap name=off|gated|on` to set run grants. YAML `capabilities` are requests, not grants;
the person starting the run chooses actual grants through the run form or `--cap`. For a custom
graph, accepted keys are `agent`, `check`, `script`, `integrate`, `push`, `land`, `updateBranch`,
`resolveConflicts`, `fixChecks` and `merge`. An Objective-routed graph accepts `plan`, `implement`,
`review`, `check` and `land`; it uses Objective defaults (`plan: gated`, `implement/review/check: on`,
and `land: on` for `files-on-disk`, otherwise `gated`). A PR-sitter-routed graph accepts
`updateBranch`, `resolveConflicts`, `fixChecks` and `merge`; absent requested modes for these four
capabilities default to `gated` (the standalone hosted-review create leaf still defaults all four
to `off`). Required node capabilities default to gated when not requested in a custom graph. A YAML
request for `push: on` or `merge: on` is clamped to gated; an explicit run-form grant or `--cap`
override is the operator's choice. The generic pipeline and Objective-routed CLI defaults are four
active hours and 40 turns; a PR-sitter-routed run defaults to four hours and unlimited turns.
`--owner` supports `claude`; `--owner-model` and `--owner-effort` require it.

The CLI validates the source and host's advertised node types before enrollment. Invalid YAML or
graph rules refuse with an error for each problem and include a node id when available; no watcher
is created. A host missing a required node type refuses before execution; old hosts also refuse
required source-bearing copies instead of dropping their pin.

```text
ORCA heimdall create --pipeline .orca/pipelines/bugfix.yaml --worktree active --spec 'fix the flaky login test' --input priority=2 --cap agent=on --cap check=on --json
```

For pipeline gates and node decisions, `approve` answers the currently open choice; omission of
`--choice` means `approve`. Available choices depend on the pending decision:

| Pending decision                                                        | Choices                                                                           |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Human gate                                                              | `approve`, `abort`; add `send-back` when a target is configured.                  |
| Retries exhausted                                                       | `retry`, `skip`, `abort`; add `send-back` when `onFail.sendBackTo` is configured. |
| Node time limit                                                         | `extend`, `retry`, `skip`, `abort`.                                               |
| Loop escalation or maximum rounds                                       | `accept`, `one-more-round`, `abort`.                                              |
| Merge conflict                                                          | `retry`, `skip`, `abort`.                                                         |
| Swarm lint, configuration, or repeated sitter failure after its own fix | `retry`, `abort`.                                                                 |

`send-back` requires a non-empty `--comment` (up to 4,000 characters); `extend` requires
`--extend-minutes` from 1 through 1440. A gate answer does not authorize a capability action.
Ordinary capability approvals remain approvals and do not accept non-`approve` choices. Take
watcher and escalation ids from `show`; the first answer wins.

```text
ORCA heimdall approve <watcherId> <escalationId> --choice send-back --comment 'split step 6'
```

## Remote ownership

Read and manage remote-owned watchers through the row returned by `list`. For every command addressed
by watcher id, the CLI resolves that row and sends its recorded `target` plus `ownerFence`; the
fence binds the mutation to the owner and revision that were observed. Never synthesize a remote
target, reuse a copied fence, or fall back to a same-id local watcher. Refresh with `list`/`show` if
ownership or pairing changes. Reads can report an unverifiable contact; a mutation that cannot reach
the owner must fail closed rather than act on another host.

Create is different: it enrolls only in a workspace local to the selected runtime; it does not
cross to a workspace owned by SSH or another runtime. Connect directly to the owning runtime to
create there. A fleet row for a different host does not make that workspace local to this runtime.

## Refusals and recovery

A command result may be `applied`, `refused`, or `indeterminate`. A refusal or indeterminate result
sets a nonzero exit code; with `--json`, read the result's `reason` and `detail`. A nonzero exit is
not permission to repeat the same command blindly.

| Result/reason               | What it means                                                                                                                        | Remedy                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `owner-unreachable`         | The owning runtime cannot be reached.                                                                                                | Restore the pairing/host connection, refresh the fleet, then retry only after contact is live. The command is not redirected to a local watcher. |
| `unsupported-capability`    | The owner does not advertise the capability required by this operation, or is too old for the command.                               | Update Orca on the owner. Do not retry against a different target or omit the capability gate.                                                   |
| `owner-conflict`            | The watcher owner or remote pairing changed.                                                                                         | Re-run `list`, select the current row, and inspect it again before acting.                                                                       |
| `stale-revision`            | The watcher changed since the owner fence was read.                                                                                  | Re-read with `list`/`show`; decide whether the requested action is still needed and issue a fresh command.                                       |
| `watcher-not-found`         | The id is unknown or was removed.                                                                                                    | Use `list` and copy a current watcher id; do not guess another id.                                                                               |
| `invalid-state`             | The operation's precondition is not met (for example, resume while budget is spent, a question is open, or the watcher is terminal). | Read `show`, address the named blocker (answer the question or raise budget before resume), and do not try to bypass terminal or disarmed state. |
| `question-already-answered` | The worker question is no longer pending.                                                                                            | Re-read `show` and use a currently pending question id, if one remains.                                                                          |
| `worker-unverifiable`       | The worker process identity cannot be confirmed for a stop request.                                                                  | Inspect worker liveness in `show`; wait for identity to become verifiable or leave it alone.                                                     |
| `coordinator-seat-lost`     | The watcher no longer has its required orchestration coordinator seat.                                                               | Re-establish coordinator ownership before retrying a steering command.                                                                           |
| `invalid-command`           | The command payload or referenced scope is invalid.                                                                                  | Correct the command arguments using current `show` data; never invent an approval scope.                                                         |
| `indeterminate`             | The request may have reached the owner, but the outcome could not be confirmed.                                                      | Read `show`/`list` before retrying so an already-applied external effect is not repeated.                                                        |

Enrollment refusals are distinct from command refusals:

- `invalid-payload` or `unknown-kind`: correct the named field or choose the appropriate
  `objective`, `hosted-review` or pipeline create path. Validation runs before enrollment; for
  hosted review, check that the selected attached Git branch has an open supported PR/MR.
- `duplicate-workspace`: inspect the existing watcher with `list --worktree <selector>` and `show`.
  Manage or re-arm the stable watcher rather than creating a second watcher for the same workspace.
- `owner-not-executable`: the selected workspace's scheduler owner cannot execute this enrollment
  from the selected runtime. Choose a workspace local to it, or connect directly to its owning
  runtime; the CLI does not redirect creation through another host.

The CLI checks required runtime capabilities before sending commands. Lifecycle commands need
`heimdall.commands.v1`, permanent removal needs `heimdall.watcher-delete.v1`, owner escalation
answers need `heimdall.watcher-answer-escalation.v1`, and configuring an owner needs
`heimdall.enroll-owner.v1`. An older runtime is a compatibility blocker: update it instead of
repeating the request.

## Next action

Start with `ORCA heimdall list --json`, then `show` the exact row before steering it. Use
`objective` for objective plan/task evidence. After acting, read the returned status; on refusal or
uncertain delivery, refresh the fleet and detail before doing anything again.
