# Heimdall Watcher

Heimdall is a deterministic reconciler kernel that supervises long-running **watchers**: durable
enrollments that wake on their own pulse, read the world, decide what to do, and act under gates and
budgets. Two kinds ship — `hosted-review` (a PR/MR sitter) and `objective` (drives a goal to a stated
landing bar across many tasks) — plus a fleet dashboard over both.

The kernel is deterministic: it owns pulse scheduling, gating, leases, budgets, the ledger, and stop
policy. LLM agents are dispatched only for judgment the kernel cannot make itself, and every action
they enable passes a capability gate first. Code owns safety; the model owns synthesis.

This document is the operating manual. For the design rationale see the spec set under
`docs/quirk/specs/2026-09-13-heimdall-watcher/`.

## Before you start

```sh
pnpm build:cli     # out/cli is not built by `pnpm dev`
pnpm dev
```

`pnpm dev` writes `orca` / `orca-dev` wrappers pointing at `out/cli/index.js`
(`config/scripts/dev-cli-terminal-wrapper.mjs:13`) but never builds it. Irrelevant for an
observation-only sitter; required before any objective run, because dispatched workers finish by
calling `orca orchestration send` (`src/main/fork-heimdall-objective/role-prompts.ts:99`).

The dev profile is `~/Library/Application Support/orca-dev`, **shared by every worktree's `pnpm dev`**
(`config/scripts/run-electron-vite-dev.mjs:428-433`). Two running instances means two writers on the
same `heimdall.db` and lease store. Quit the others, or isolate with
`ORCA_DEV_USER_DATA_PATH=/tmp/orca-heimdall pnpm dev` — a fresh profile has no repos registered, so
you re-add them.

`gh` (or `glab`) must be authenticated before arming a sitter. The sitter reads review state every
tick regardless of which capabilities are enabled.

## Where it lives

The kernel starts unconditionally at app boot (`src/main/startup/main-process-runtime-service.ts:142`)
and loads its database as soon as the window renders. There is **no feature flag, setting, or
environment variable** that turns Heimdall on or off — with no enrollments it simply does nothing.

The sidebar **Heimdall** entry is rendered unconditionally (`SidebarNav.tsx:233`), unlike its
flag-gated siblings. There is **no CLI, no keyboard shortcut, and no command-palette entry**.
Enrollment happens on exactly two surfaces:

| Kind            | Path                                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `objective`     | Sidebar → Heimdall → **New objective** (`HeimdallPage.tsx:196-205`)                                                                             |
| `hosted-review` | Open a worktree with an open PR/MR → right sidebar Checks panel → **PR Sitter** → **Arm** (`right-sidebar/checks-panel/active-content.tsx:215`) |

## Judgment: opt-in shadow observations

Objective watchers can batch typed Jev judgment questions through TypeSafe directly or OpenRouter's
[Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request).
This is **off by default**. Every registered question also starts in **shadow mode**: answers are
recorded, but do not change decisions. Published confidence tiers are seed values, not calibrated
authority; graduating a question requires a code change to its mode, threshold and calibrated model.

Access lives in `fork-heimdall/judgment-access.json` beside the profile's `heimdall.db`, not in an
enrollment, objective contract, or fleet mirror:

```json
{ "enabled": true, "provider": "openrouter", "apiKey": "YOUR_OPENROUTER_API_KEY" }
```

OpenRouter uses `~typesafe/jev-latest` at `https://openrouter.ai/api/alpha/decisions`, not chat
completions. For direct TypeSafe access, set `"provider":"typesafe"` and supply a TypeSafe key;
omitting `provider` also selects TypeSafe. There is no automatic provider fallback.

On a standard macOS installation, the active profile's file is
`~/Library/Application Support/orca/profiles/<activeProfileId>/fork-heimdall/judgment-access.json`.
The profile ID is in `orca-profile-index.json`; the default is `local-default`. Development builds
normally use `orca-dev` instead of `orca`. The running build must include judgment support.

On macOS/Linux the file must have private permissions (`chmod 600`). Delete it or replace its
contents with `{"enabled":false}` to disable judgment. Invalid configuration degrades to a recorded
absence without exposing the key in diagnostics. There is no runtime setting for graduating a
question out of shadow mode.

Enabling access permits sending bounded objective, plan, validated report, and relevant ledger
projections to the external API. Only local desktop watchers participate; SSH, WSL and runtime-owned
watchers record an explicit remote-host absence without reading the credentials or calling the API.
This supports both Git and folder objectives.

The read phase asks one batch per new `(contentIdentity, projection digest)`. A newly arrived report
changes that identity even if workspace files did not change. Answers and failures are pinned
`client-observation` ledger entries, not a second cache; replay and unchanged ticks do not ask again,
even after changing providers. New answers record their transport provider and the exact returned
model stamp; model aliases are not treated as calibrated versions. Choice/Score answers without
confidence or probabilities are unavailable, never assigned synthetic confidence.
A durable pending entry prevents a restart from repeating an interrupted invocation.

Before applying the 32 KiB state limit, the judgment projection losslessly shares exact repeated
string values through a versioned `normalization.strings` table. Each original field keeps its
location and a reference to the shared value; record order, source claims, and relationships remain
distinct. Native reference-looking objects are escaped. Trusted question instructions explain how
to expand references and literal escapes; referenced worker text remains untrusted data.
Normalization is used only when the complete encoded UTF-8 JSON is smaller, including its table
and reference overhead. This is lossless relative to the existing judgment projection, not a
replacement for its field filtering or latest-ledger-entry folding.

If the normalized state still exceeds 32 KiB, the projection drops the oldest historical groups
until it fits, normalizing each candidate again. This can omit the original plan seed once an approved plan supersedes it, superseded
revisions and their nodes, and completed attempt/report history. Questions about omitted historical
subjects are not sent. The current plan, pending/running work, and open escalation evidence remain;
if that required context alone cannot fit, judgment is unavailable. Text is never sliced to fit.

The exact encoded state, normalization format, and truncation counts/policy participate in the
input identity, so changed bounded input does not replay an earlier oversized-state failure.
The outcome and Decision Trace record normalization savings and any omission notice; unchanged
input still replays without another call. The full watcher world and historical ledger entries
are unchanged.

Decoding guidance also counts toward the 256 KiB complete-request limit. If that overhead would
overflow the request, an unencoded projection may be used with the same history-bounding policy,
but only if both its state and complete request fit. Identity and notices follow the chosen form.
Successful or pending judgments replay across provider changes when the retained context is
identical; an older, more-pruned answer cannot suppress judgment of newly retained context.

HTTP 429/529 get at most three attempts with 100/200 ms backoff; each attempt times out after five
seconds. Other failures fall through to the deterministic path and are recorded.

The **Decision Trace** shows participation and why answers were held (including shadow mode),
distinct from disabled, remote, unavailable or never-completed requests. **Ledger activity** retains
the typed answers and model stamps. Each newly observed model version produces a notice. Approval
cards can display an advisory prediction, explicitly labelled shadow or acting; approval still
requires the human.

Registered consumers cover failure classification, task-scoped agent routing, escalation triage,
report/verdict quality, preflight, handoff, and adversarial screening. Acting consumers require their
own confidence threshold, an explicitly calibrated model and a clean adversarial screen. Retry
allowances remain deterministic: every routed redispatch consumes the existing two-retry limit.
Quality disagreement requests one additional reviewer for the immutable source claim rather than
rejecting the worker's report.

Escalation triage is recorded, but **automatic escalation rerouting is not enabled or wired**:
the existing worker-escalation lifecycle parks before dispatch selection. Allowing judgment to
bypass that park conflicts with the specification's prohibition on stop-predicate influence and
requires an explicit authority decision. Stop predicates, liveness, pacing and human consent remain
deterministic.

## The pulse

Each watcher reconciles on its own timer. The kind picks a tier each tick; the kernel converts it to
a delay (`src/shared/fork-heimdall/pacing.ts:3-8`).

| Tier      | Delay | When                                                    |
| --------- | ----- | ------------------------------------------------------- |
| `rapid`   | 15s   | checks in flight; objective landing/committing/pushing  |
| `active`  | 60s   | a worker dispatch is in flight; a required check failed |
| `idle`    | 5 min | nothing moving; awaiting approval; budget spent         |
| `stopped` | —     | terminal state reached                                  |

A forced full resync runs every 15 minutes regardless of tier. Consecutive errors add exponential
backoff from 30s to a 15-minute ceiling (`pacing.ts:34-40`).

Enrolling and resuming both schedule an **immediate** first tick (`kernel-service.ts:419`), so the
first ledger entries appear within seconds. After that you wait the real interval — there is no
fast-forward. `reconcileForTesting` exists but is wired to no IPC channel; it is for unit tests only.

## Status vocabulary

Every watcher is in exactly one state (`watcher-types.ts:100-110`), shown as a pill in the fleet list
and detail pane. The labels in the second column are what the UI actually renders
(`watcher-status-copy.ts:12-24`).

| State         | Label            | Meaning                                                   |
| ------------- | ---------------- | --------------------------------------------------------- |
| `watching`    | Watching         | observing; no action pending                              |
| `acting`      | Acting           | executing or dispatching an action                        |
| `held`        | Held             | an action was chosen but a gate held it                   |
| `escalated`   | Escalated        | a preflight or gate declared this needs a human           |
| `parked`      | Parked           | the watcher auto-disabled itself — see park reasons below |
| `terminal`    | Complete         | permanent stop; will not run again                        |
| `disabled`    | Stopped          | explicitly disarmed                                       |
| `unreachable` | Host unreachable | the owning process or host cannot be reached              |

_Host unreachable_ overrides every other label whenever contact is `unverifiable`, and carries a
last-confirmed age (`HeimdallStatusPill.tsx:8-21`).

**Ways a watcher parks** — the typed reasons are defined in `watcher-types.ts`; worker escalation
and configuration failure use dedicated park paths. Each disables the enrollment and opens a
`park-<reason>` escalation:

| Reason                  | Trigger                                                 | Recovery                                                                      |
| ----------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `budget`                | active-time or turns spent                              | raise the budget, then resume                                                 |
| `stop-predicate`        | a kind's stop condition fired non-terminally            | resume                                                                        |
| `worker-question`       | a dispatched worker is blocked on a question            | answer it, or resume once the worker exits                                    |
| `worker-escalation`     | a worker explicitly requested operator intervention     | inspect the escalation, then resume; self-clears if that dispatch later lands |
| `configuration-error`   | durable workspace or execution authority no longer fits | fix the configuration, then resume or re-arm                                  |
| `coordinator-seat-lost` | this process lost its orchestration coordinator seat    | re-establish ownership                                                        |

## Capability gates

Every action a watcher wants to take names a capability, and every capability is in one of three
modes:

| Mode    | UI label | Effect                                                                                                                                    |
| ------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | Off      | the action is never taken; gate holds with `capability-off` and raises **no** escalation — the watcher silently re-proposes it every tick |
| `gated` | Ask      | the action waits for an explicit human approval                                                                                           |
| `on`    | On       | the action runs unattended                                                                                                                |

Approval is **scoped**, not blanket. The scope is
`{actionKind, contentIdentity, evidenceKey, preparedCommitSha?}` (`gate.ts:45-54`), compared
field-for-field. Approving a push of one content state does not pre-approve the next one. If the
content or prepared commit changes, you are asked again. Repeated holds for the exact same unresolved
scope fold into one logical escalation even when unrelated ledger rows intervene; approval resolves
every open or escalated duplicate for that exact scope, not a broader action class
(`gate.ts`, `approval-resolution.ts`).

The gate can hold for reasons other than capability mode. These are the strings you will see in the
decision trace (`gate.ts:100-155`):

| Hold reason                            | Meaning                                                     |
| -------------------------------------- | ----------------------------------------------------------- |
| `parked`                               | the watcher is parked awaiting something external           |
| `budget-wall-clock` / `budget-turns`   | that budget is spent                                        |
| `stop-predicate-fired`                 | the kind's stop condition is true                           |
| `attempt-completed`                    | this exact attempt already landed                           |
| `attempt-in-flight`                    | an attempt with this fingerprint is running                 |
| `retry-needs-new-evidence`             | the last attempt failed; a retry needs a fresh read         |
| `unresolved-attempt`                   | an external action has unknown outcome; will not double-act |
| `stale-evidence`                       | the world changed since the action was decided              |
| `missing-expected-state`               | an external action arrived without its expected-state guard |
| `capability-off` / `awaiting-approval` | see above                                                   |

`unresolved-attempt` and `missing-expected-state` are the safety interlocks that stop a watcher from
repeating an external effect it cannot confirm.

## Escalations

Escalations are ledger entries with an open/acknowledged/resolved status. Some need you; some are a
record of something that happened.

| Kind                         | Needs you? | What it means                                                     |
| ---------------------------- | ---------- | ----------------------------------------------------------------- |
| `awaiting-approval`          | **yes**    | a `gated` capability wants an action approved                     |
| `worker-question`            | **yes**    | a worker is blocked on a question; answer it from the detail pane |
| `worker-escalation`          | **yes**    | a worker explicitly requested operator intervention               |
| `park-budget`                | **yes**    | budget spent; raise it, then resume                               |
| `park-worker-question`       | **yes**    | parked because of the above question                              |
| `park-worker-escalation`     | **yes**    | parked because of the above escalation                            |
| `park-configuration-error`   | **yes**    | durable workspace or authority configuration no longer matches    |
| `park-coordinator-seat-lost` | **yes**    | orchestration ownership lost                                      |
| `park-stop-predicate`        | sometimes  | resume if you disagree with the stop condition                    |
| `invalid-kind-payload`       | **yes**    | the enrollment is malformed; commands are refused on it           |
| `control-disarm`             | no         | records an explicit disarm                                        |
| `malformed-ledger-entry`     | no         | diagnostic: a ledger append failed validation                     |
| `handoff-refused`            | no         | records a refused objective → sitter handoff                      |

The detail pane lists only `open` and `escalated` ones (`HeimdallDetailPane.tsx:162-170`).

## Budgets

Two limits, both optional (`null` means unlimited) — `src/shared/fork-heimdall/budget.ts`.

- **Active time** is _not_ wall-clock since enrollment. It is the sum of open work intervals: an
  interval opens when work starts and closes when it ends. An interval closed with reason
  `contact-lost` only counts up to its last checkpoint (`budget.ts:56-59`), so a disconnected SSH
  host does not bill you for time you could not observe.
- **Turns** counts distinct _successful worker dispatches_ — planner, implementer, reviewer,
  integrator launches — not LLM round-trips (`ledger-lifecycle.ts:340-349`). A dispatch that fails
  before launching costs no turn.

Time spent waiting on a worker's question is **not** billed: the interval closes the moment a question
is detected and reopens when work resumes (`ledger-lifecycle.ts:183-200`).

An explicit **Disarm** ends the current budget generation. Enrolling the same workspace again
re-arms the stable watcher identity but appends a durable `budget-generation` evidence boundary:
active time and turns restart at zero against exactly the newly requested limits. Earlier intervals,
turns, attempts, and outcomes remain in the ledger for audit. A late close for an old interval and a
late recovered dispatch for an attempt begun before the boundary are not charged to the new
generation. Pause/resume and re-enrollment from an automatic park do not create this boundary, so
they preserve consumed usage.

An interval is opened by the budget clock when an action goes in flight or a worker is dispatched,
sampled every 15s, and durably checkpointed at most once a minute (`budget-clock.ts:9-10`). On
restart, any interval left open by a crash is force-closed as `contact-lost`
(`budget-clock.ts:198-230`).

When either limit is reached the watcher does not merely stop acting — it **parks**: `enabled` flips
to `false`, a `park-budget` escalation opens, and the status pill reads _Parked_
(`runner-loop.ts:323-329`, `runner-status.ts:44-75`).

Recovering from a parked watcher is a two-step sequence, and the order matters:

1. Raise the limit with **Apply budget** in the detail pane (`HeimdallDetailPane.tsx:412-508`). This
   has no enabled/paused precondition and applies immediately.
2. Then **Resume**.

Resuming first does nothing useful: `resume` refuses while the _current_ budget is still exhausted
(`control-enrollment-lifecycle.ts:85-87`), which the UI surfaces as "This watcher exhausted its
budget. Increase the limit before resuming or it will park again." `resume` refuses for an open
worker question too — answer it first.

If the worker exited before you got there, its thread is closed and no answer is possible. Heimdall
voids the question on the next tick and on **Resume** itself, records a `worker-question-void`
evidence entry, and leaves the watcher parked so you can read the failed worker's report before
restarting it. A question whose thread is merely unreachable stays open — lost contact is not
settlement.

**A turn budget of `0` is accepted and parks the watcher on its first tick**, because `turns >= 0` is
immediately true. The UI's `min="0"` allows it (`objective-enrollment-model.ts:168-171`).

## The workspace lease

One watcher at a time may write to a given workspace. The lease is a directory of numbered epochs on
the watched host — `.git/orca-heimdall/lease/epoch-N/holder.json` for a git workspace,
`.orca/heimdall/lease/epoch-N/holder.json` for a folder (`lease-store.ts:259,277`) — not in the
Orca profile, so it fences across app instances and across SSH.

The TTL is 90 seconds and the holder renews at a third of that (`runner-loop.ts`,
`lease-store.ts`). A holder that stops renewing is considered expired and the next watcher claims a
higher epoch, which fences the old one out. Release is authenticated with both the holder identity
and epoch: a stale holder cannot mark a successor's lease released. **A crashed app's lease
self-heals after ~90 seconds; you do not need to delete anything.**

The three failure modes look different in the UI:

- **`refused`** — someone else holds a live lease. The tick exits with `lease-refused` and quietly
  retries at rapid pace. No visible alarm; the watcher just never progresses.
- **`unverifiable`** — the host or filesystem could not be reached. The status becomes
  `unreachable` / `lease-unverifiable`, any active dispatch is closed for contact loss, and the pill
  switches to _Host unreachable · last confirmed …_. Contact loss is retried; it is not evidence
  that an asynchronous effect failed or did not land.
- **`configuration-error`** — the durable target no longer resolves to the enrolled workspace or
  authority. The watcher disables and parks with `park-configuration-error` instead of retrying a
  configuration that cannot become correct merely through renewed contact.

## Kind: `hosted-review` (PR Sitter)

Watches one pull or merge request: updates its branch, resolves conflicts, reruns and fixes failing
checks, and merges — each a separately gated capability.

| Setting            | Values                                              | Default            | Notes                                                          |
| ------------------ | --------------------------------------------------- | ------------------ | -------------------------------------------------------------- |
| `updateBranch`     | off / gated / on                                    | **off**            | authorizes bringing the branch up to date with base            |
| `resolveConflicts` | off / gated / on                                    | **off**            | authorizes conflict resolution                                 |
| `fixChecks`        | off / gated / on                                    | **off**            | authorizes dispatching an agent to fix failing checks          |
| `merge`            | off / gated / on                                    | **off**            | authorizes the merge API call                                  |
| Branch update mode | merge base into branch / rebase onto base           | merge-base-update  |                                                                |
| Merge method       | repository default / merge commit / squash / rebase | repository default |                                                                |
| Active budget      | hours > 0, step 0.25                                | 4                  | no upper bound; counts only while a worker or action is active |

All four capabilities default to `off` (`HostedReviewSitterPanel.tsx:43-48`), so a freshly armed
sitter reads and decides but never acts. The three modes are labelled **Off / Ask / On** in this
dialog. Repo, worktree, branch, provider, review number and URL are taken from the open review
context, not typed in (`HostedReviewSitterPanel.tsx:282-299`).

The dialog also carries a **Copy debug report** button — the only debug surface wired to a UI
control.

### What it takes to arm one

Identity is re-derived at arm time; the renderer's values are only a candidate
(`definition.ts:49-130`). All of the following must hold, or enrollment throws:

- a real git worktree — not bare, not prunable, with an **attached** (non-detached) branch;
- an open or draft review on that branch, from GitHub or GitLab.

On any other provider the PR Sitter control simply does not render — no error, it is just absent
(`HostedReviewSitterPanel.tsx:228-230`).

### Actions and the capability each needs

| Capability         | Actions                                                      |
| ------------------ | ------------------------------------------------------------ |
| `fixChecks`        | `rerun-check`, `prepare-fix`, `publish-fix`                  |
| `resolveConflicts` | `prepare-conflict-resolution`, `publish-conflict-resolution` |
| `updateBranch`     | `update-branch`                                              |
| `merge`            | `enqueue`, `merge`                                           |

The `prepare-*` / `publish-*` split matters: preparing is a local commit in your worktree, publishing
is the push. With a capability on **Ask**, Orca may prepare and commit a fix locally and then waits
for you before publishing it, triggering CI, updating the branch, or merging.

### What it reads every tick

Reads are **never** capability-gated — they happen even with everything Off (`kind.ts:59-77`). Each
tick pulls PR/MR lifecycle, head and base SHAs, draft flag, every check with its state and failure
signature, provider readiness and its blockers, behind-base, conflicts, merge-queue membership, and
the repository's default merge method.

GitHub goes through the authenticated `gh` CLI (GraphQL plus REST for branch rules and failure logs);
GitLab through `glab`. Neither CLI's auth is checked proactively — a missing login surfaces as a raw
exec error. When the provider reports mergeability as unknown, the sitter falls back to a local
`git merge-tree` simulation (`provider-git.ts:106-164`).

### Branch update: the force-push distinction

| Provider + mode           | Mechanism                                                 | Force-push?                   |
| ------------------------- | --------------------------------------------------------- | ----------------------------- |
| GitHub, merge-base-update | GitHub's own `update-branch` endpoint; no local git write | **no**                        |
| GitHub, rebase            | local `git rebase`, then push                             | **yes**, `--force-with-lease` |
| GitLab, either mode       | local `git merge` or `git rebase`, then push              | **yes**, `--force-with-lease` |

Rebase mode rewrites commit SHAs and may dismiss existing approvals — the form warns about this
(`HostedReviewSitterEnrollmentForm.tsx:186-190`). On a rejected push the local branch is hard-reset
back to its expected head rather than left in a half-updated state (`git-branch-update.ts:290-329`).

### Merge method and merge queues

`Repository default` is stored as `null` and resolved at decide time to the repo's configured
default. If the target requires a **merge queue or train**, a direct `merge` is refused at the
provider layer and the sitter emits `enqueue` instead. If your pinned merge method conflicts with the
queue's configured method (GitHub) or the project's strategy and squash option (GitLab), the action
throws rather than overriding the protection.

### How `fixChecks` actually works

1. **Rerun first.** Unless the same failure signature already reproduced on two distinct runtimes,
   the sitter reruns the failed job before concluding anything.
2. **Prepare.** Once a failure signature is established it dispatches an unattended coding agent into
   your worktree under a fixed policy: it may apply mechanical fixes and fix the demonstrated defect;
   it must escalate on anything ambiguous or behaviour-changing; and it must **never** skip or disable
   tests, suppress lint or type errors, weaken CI gates, or push (`agent-prompt.ts:3-20`). It must
   produce exactly one commit carrying an `Orca-Heimdall-Attempt` trailer.
3. **Inspect.** The resulting diff is statically checked before anything is published — CI-definition
   edits, baseline/ratchet edits, added suppressions, added test skips, added CI-bypass flags, test
   deletion, and net test-contract narrowing are all refused (`agent-policy.ts:110-162`).
4. **Publish.** A normal push with expected-state guards.
5. **Verify.** The sitter never runs the check itself. It waits for the next fresh provider read of
   the new head. If the same check fails again with the same signature on a commit the sitter itself
   produced, the watcher parks rather than trying again.

### Contention and push targets

Before any action that writes the worktree, the sitter requires a complete, reachable terminal census
and applies its clean-tree rules. A publication traces the preparation attempt's `dispatchId` to its
still-owned orchestration terminal, so the sitter's own worker is not mistaken for a foreign agent.
An unrelated agent or terminal still blocks; a missing, adopted, released, or otherwise unverifiable
owned session holds conservatively, and an owned session that exited leaving uncommitted changes is
reported as an abandoned sitter fix (`contention.ts`, `agent-publication.ts`).

For pushes it resolves the review's source repo against your configured remotes and requires
**exactly one** match. Zero or ambiguous matches make every push-dependent action fail with "push
target is unverifiable" (`provider-push-target.ts:75-223`). Push uses your local git credentials —
SSH key or credential helper — which are separate from the `gh`/`glab` API token, and needs
force-push rights on the source branch.

### When a sitter stops

| Predicate                                                               | Disposition                     |
| ----------------------------------------------------------------------- | ------------------------------- |
| review merged or closed                                                 | **terminal** — permanently done |
| a check failed again with the same signature after the sitter's own fix | park                            |
| a rerun reproduced failures that carry no classifiable signature        | park                            |

Only the first is terminal. The two park cases disable the watcher and open an escalation; you can
raise the issue yourself and resume, or disarm.

## Kind: `objective`

Drives a goal to a landing bar across many tasks, dispatching planner, implementer, reviewer and
integrator roles into the workspace.

When a worker reports completion or its execution host confirms it has exited, Heimdall settles its
dispatch and automatically requests `orchestration.workerRelease`. The existing release path archives
output before closing the worker's terminal; a single-pane worker tab disappears. A worker terminal
adopted through user interaction, or otherwise no longer owned by the dispatch, is retained. Release
receipts are recorded as `worker-terminal-released` evidence, including the retention reason. A
release error is recorded without failing the watcher tick or undoing settlement.

A `worker_done` report settles with the worker's declared certainty. An explicit worker escalation is
recorded as `worker-escalation`, closes active billing, and parks the watcher; **Resume** acknowledges
both the park and the unresolved worker escalation before scheduling the next tick. If the dispatch
settles before acknowledgement, its still-unresolved worker escalation is resolved.

A resolved escalation then retires its own park, but only when that dispatch settled as `landed` — a
worker that escalated and afterwards reported `succeeded` un-parks the watcher on the next tick with
no operator action, and the `park-worker-escalation` entry folds to `resolved`. A dispatch that
settled any other way, including one confirmed exited without a report, keeps the watcher parked so
an operator reads what went wrong before it runs again. An escalation nothing resolves — one carrying
no dispatch id, or whose dispatch is still running — also keeps the park.

A dispatch confirmed exited without a `worker_done` report remains `indeterminate`; process exit does
not prove what its asynchronous work changed. A late `worker_done` still takes precedence and follows
normal report validation, and a report on disk alone is never trusted. Contact loss is likewise
`indeterminate`, not evidence of exit. Recovery can request cleanup for older exited dispatches, but a
recorded release receipt or release error prevents duplicate cleanup attempts; it does not upgrade an
ambiguous effect to `not-landed`.

| Setting              | Values                                        | Default          | Notes                                                                                                                      |
| -------------------- | --------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Workspace            | repo / worktree / folder                      | —                | required; determines available landing rungs                                                                               |
| Objective text       | ≤ 16,384 chars                                | —                | required (`contract-types.ts:4`)                                                                                           |
| Existing plan source | ≤ 65,536 chars                                | blank            | optional planner input; not an approved executable plan                                                                    |
| Tier                 | express / standard / full                     | standard         | how much review is required — see below                                                                                    |
| Landing bar          | 5 rungs                                       | files-on-disk    | how far to take the work — see below                                                                                       |
| Max concurrency      | 1                                             | 1                | read-only; the schema allows 1,024 but the main process throws `max-concurrency-unsupported` above 1 (`definition.ts:156`) |
| Write territory      | 0–64 workspace-relative globs                 | **blank = `**`** | optional; blank allows the whole workspace — see below                                                                     |
| Active budget        | ≥ 0.25 h, 0.25 steps                          | 4                | slider tops out at 24 h, the input does not                                                                                |
| Worker turn limit    | integer ≥ 0                                   | 40               |                                                                                                                            |
| Capabilities         | plan / implement / review / check / land      | see below        |                                                                                                                            |
| Role agents          | planner / implementer / reviewer / integrator | automatic        |                                                                                                                            |
| Sitter overrides     | four sitter capabilities                      | inherit          | applied at handoff                                                                                                         |

### Capability defaults are not conservative

`objectiveCapabilityModes` (`contract-types.ts:157-165`) returns:

```
plan:      gated
implement: on
review:    on
check:     on
land:      on    (files-on-disk)  /  gated  (every other bar)
```

So a default objective enrollment dispatches real agent sessions and runs real shell commands on its
**first tick**, without asking. Only planning and real git effects are gated. Lower the turn budget
and narrow the territory before the first run.

### Existing plan source and Plan Off

**Existing plan source** accepts pasted or imported Markdown, text or JSON, but remains raw planner
input. The planner must normalize it into the objective store's validated revision and normal Plan
approval still applies. The raw `existingPlan` text is never dispatched directly to implementers and
does not itself authorize execution.

A new objective therefore cannot set Plan to **Off** merely because source text was supplied.
`plan-off-requires-approved-plan` is refused unless this is a legitimate re-arm of the same objective,
the objective store still has a usable approved revision, and the objective text and
write-territory set match the prior contract. This prevents Plan Off from turning an unreviewed text
blob, a stale revision, or a plan approved for different work into an executable plan
(`definition.ts`, `objective-store-queries.ts`).

### Tier

Tier controls how many review roles must approve before work can land
(`decide-review.ts:235-265`, `local-action-executor.ts:376-379`):

| Tier       | Reviewer     | Integrator   |
| ---------- | ------------ | ------------ |
| `express`  | skipped      | skipped      |
| `standard` | must approve | skipped      |
| `full`     | must approve | must approve |

A `block` verdict from either role does not stop the run — it triggers a replan
(`replan-after-block`).

### Landing bar

The ladder is ordered; an objective climbs it one rung at a time
(`landing-ladder.ts:4-10`).

| Rung                     | Means                                       |
| ------------------------ | ------------------------------------------- |
| `files-on-disk`          | changes exist in the workspace, uncommitted |
| `committed-local-branch` | committed to the attached branch            |
| `pushed-ref`             | pushed to the remote                        |
| `hosted-review`          | a PR/MR is open for it                      |
| `merged`                 | merged                                      |

**`merged` is a misnomer for the objective watcher.** `stopRungForBar('merged')` returns
`hosted-review` (`landing-ladder.ts:68-70`): the objective never merges. Choosing `merged` only
changes what the handed-off sitter is allowed to do — its `merge` capability becomes `gated` instead
of `off`.

Reaching the bar is **terminal**, not idle: the `objective-bar-reached` predicate has
`disposition: 'terminal'` (`stop-policy.ts:97-121`), so the watcher stops permanently rather than
parking, and that is what triggers the handoff. A terminal watcher cannot be resumed.

Workspace constraints:

- a **folder** workspace supports only `files-on-disk` — anything else throws `landing-bar-requires-git`;
- a **git** workspace always requires an explicit worktree, whatever the bar (`definition.ts:168-172`);
- `hosted-review` and `merged` additionally require a detected GitHub or GitLab forge, else
  `landing-bar-requires-supported-forge`.

Changing the landing bar in the enrollment sheet also flips the `land` capability between `on` and
`gated` live, so re-check it after changing the bar.

### Write territory

The declared blast radius: workspace-relative globs naming everything the objective's agents may
modify. The field is **optional** — leaving it blank stores the single glob `**`, which allows the
entire workspace (`objective-enrollment-model.ts:81-87`). Otherwise up to 64 unique globs, one per
line.

`*` `?` `**` are supported; `[] {} () !` are refused, as are absolute paths, `~`, backslashes, drive
letters, control characters, and parent traversal. A glob rooted at `.git` or `.orca` is refused —
with one exception: the bare `**` is allowed and is not subject to that check
(`contract-types.ts:117-127`).

> Leaving this blank gives the objective's agents the whole workspace. Territory is the guardrail
> that actually bounds a bad run (layer 4 below is the only check that does not trust the agent), so
> set it deliberately rather than by default.

It is enforced in five places, and the last two do not trust the agent:

1. **Prompt** — pasted into every role prompt under `WRITE TERRITORY:` (`role-prompts.ts:113`).
2. **Plan validation** — a planner task declaring a path outside is rejected (`plan-schema.ts:293`).
3. **Implementer report** — a reported modified path outside is rejected (`plan-schema.ts:311`).
4. **Observed disk changes** — a fingerprint manifest is taken before dispatch and diffed after. Any
   path that actually changed outside the territory fails the attempt with
   `observed-change-outside-write-territory:<path>`, whatever the agent reported. The reported list
   must then exactly equal the observed list, so under- and over-reporting both fail
   (`observed-workspace-changes.ts:297-313`).
5. **Commit staging** — `git add` / `git commit` receive only inside-territory paths
   (`landing-action-executor.ts:133-147`). Outside-territory dirt is left uncommitted and surfaced as
   `outsideTerritoryPaths` rather than swept in.

Layers 2–3 catch an honest agent. Layer 4 is what actually bounds the damage.

### Actions and the capability each needs

Every tick the objective decides at most one action (`objective-actions.ts`):

| Capability  | Actions                                                                   |
| ----------- | ------------------------------------------------------------------------- |
| `plan`      | `dispatch-planner`, `ingest-plan`, `activate-plan`                        |
| `implement` | `dispatch-node`, `ingest-report`                                          |
| `check`     | `run-check`                                                               |
| `review`    | `dispatch-reviewer`, `dispatch-integrator`, `ingest-verdict`              |
| `land`      | `record-landing`, `commit-local-branch`, `push-ref`, `open-hosted-review` |

### What the agents are told

Each dispatched worker gets a structured prompt (`role-prompts.ts:105-121`) carrying the objective
text, tier, landing bar, budget bucket, `CONCURRENCY: 1`, the write territory as a bullet list, a
role instruction, role context (the assigned node, or the plan review view), a strict JSON report
contract, and the exact `orca orchestration send --type worker_done` line to finish with. The report
must be written atomically to an absolute path the kernel supplies; the kernel parses and validates
it against a schema, so a malformed or out-of-territory report fails the attempt rather than being
interpreted loosely.

Role agents resolve as `contract.roleAgents[role] ?? settings.defaultTuiAgent`, so leaving a role on
_automatic_ uses the **owning host's** default TUI agent. An unknown agent id is rejected at
enrollment (`definition.ts:54-60`); one that is known but disabled fails later, at dispatch
(`role-prompts.ts:129-140`). The ids offered per workspace are those actually detected on that
workspace's execution host — local, SSH target, or paired runtime — so the list differs between a
local worktree and a remote one.

> **Set a default TUI agent before using _automatic_.** The shipped default is `null`, and a `null`
> default fails every role dispatch. There is no stop predicate for repeated dispatch failure, so the
> objective replans and retries forever — burning active time (each failed attempt still opens an
> interval) but no turns, until the active-time budget runs out and it parks. The symptom is a
> watcher that replans endlessly and never dispatches.

## The handoff

An objective that reaches `hosted-review` terminates and enrolls a sitter for the PR it opened. This
happens for both the `hosted-review` and `merged` landing bars; below those, no sitter is ever
enrolled and your sitter overrides are simply unused (`kind.ts:115-123`).

The derived sitter is deliberately more conservative than a hand-armed one
(`objective-handoff-policy.ts:37-60`):

```
updateBranch:     gated
resolveConflicts: off
fixChecks:        gated
merge:            gated  if landing bar was `merged`, else off
```

Your sitter overrides replace these — with one exception: **`merge: on` is downgraded to `gated`**
(`objective-handoff-policy.ts:57`). There is no configuration that produces an unattended merge
through the handoff.

Three more things the handoff fixes for you: the sitter inherits the objective's **remaining** budget
rather than a fresh one (`remainingBudget`, `:63-70`), `branchUpdateMode` is hardcoded to
`merge-base-update`, and `mergeMethod` is `null` (repository default) — overrides touch capabilities
only. The review body is the objective text followed by every plan criterion as an acceptance
checklist (`renderReviewBody`, `:92-101`).

## Reading the fleet page

The header shows `{active} active · {attention} need attention` plus **New objective** and a refresh
button. Below: the watcher list, then a fleet-wide activity feed. Selecting a row opens the detail
pane (`HeimdallDetailPane.tsx:344-568`), which carries, in order: owner controls (pause / resume /
disarm), budget with editable limits and **Apply budget**, escalations with an Approve action,
kind-specific detail, live workers, the decision trace, and the watcher ledger.

If a refresh fails the page keeps showing the last confirmed snapshot behind a warning banner rather
than blanking (`HeimdallPage.tsx:219-230`).

### Controls

Seven commands, all routed through `heimdall:command` and fenced by owner identity and a command
revision, so a stale or wrong-owner request is refused (`control-plane.ts:107-131,400-431`).

| Command           | Precondition                   | Effect                                                                                 |
| ----------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| `pause`           | active                         | waits for the in-flight tick, commits `paused`, releases the lease                     |
| `resume`          | paused or auto-parked          | re-enables; **refuses** if budget is still exhausted or a worker question is open      |
| `disarm`          | not already disarmed           | stops the current enrollment generation, resolves open escalations, releases the lease |
| `approve`         | not disabled or paused         | approves one action scope and reschedules immediately                                  |
| `adjust-budget`   | none                           | commits a new budget and updates the live status                                       |
| `answer-question` | question still open            | answers the worker and un-parks the watcher                                            |
| `stop-worker`     | exact process identity matches | stops one worker                                                                       |

**Disarm cannot be undone with Resume.** `resume` requires `paused` or an automatic park. A later
`enroll` for the same workspace re-arms the stable watcher record as a new budget generation while
retaining its audit ledger (`kernel-enrollment-lifecycle.ts`, `budget.ts`).

`stop-worker` requires an exact process identity before it will issue the stop, and reports
`applied`, `refused`, or `indeterminate` rather than guessing (`worker-controls.ts:131-208`).

### Ledger and decision trace

The ledger is append-only while a watcher is active, with entry kinds `attempt`,
`attempt-resolved`, `attempt-abandoned`, `approval`, `escalation`, `evidence`, `interval-open` /
`-checkpoint` / `-close`, `turn`, `client-observation` and `terminal` (`ledger-types.ts`).

Retention has an active and a terminal policy. While enrolled and non-terminal, fact-class rows are
unbounded; only resolved observation-class rows and unpinned tick traces are reclaimed into bounded
rings. Terminal transition then compacts ordinary history, retaining the `terminal` ledger row and a
durable terminal summary with kind, terminal state, reason, timestamp, and final active-time/turn
totals. Pinned unresolved rows remain until they can safely be released. The detail activity list
shows the 30 most recent surviving entries. Do not treat terminal compaction as a full audit archive,
or the active fact guarantee as a bounded-storage guarantee (`retention.ts`).

The decision trace records each tick as **Saw** (the snapshot it read), **Decided** (the action
chosen, or why none was, plus the gate verdict), and **Declined** (phases evaluated that did not
fire, plus any tick error) — `HeimdallDecisionTrace.tsx:84-136`. This is the first place to look when
a watcher appears stuck.

### Notifications

Exactly two transitions notify (`notification.ts:38-71`):

- a **new** `awaiting-approval` escalation, and only on its first fold — repeated identical holds stay
  silent;
- entry into the `terminal` state.

Both require live contact on both reads. Delivery is gated on the master
`notifications.enabled` setting only (`notification.ts:100-106`).

### Watchers on other hosts

The fleet page merges local watchers with those owned by paired runtime environments
(`fleet-transport.ts`). Each owner stamps rows independently: a row's `observedAtMs` advances only
when that watcher's projection or owner revision changes, while the enclosing snapshot's
`generatedAtMs` may advance for unrelated rows. Detail refresh and last-confirmed age use the row
stamp, not a fleet-global freshness claim. A fleet read refreshes local state first and returns it
with the cached remote rows; remote subscription setup and reconnect do not hold the local page open.

Caveats worth knowing before you rely on paired reads:

- Commands need the remote host to advertise `heimdall.commands.v1`; an older host returns
  "The owning runtime does not support Heimdall commands. Update the host and try again."
- Ledger and detail readers negotiate
  `heimdall.dispatch-result-pre-dispatch-failure.v1`. A capable paired reader retains the optional
  nested dispatch result `{status:'refused', reason:'pre-dispatch-failure', detail}`. For an
  incapable paired reader, the owner omits **only** that optional nested `result`; the attempt still
  carries `effect: 'not-landed'` and `reason: 'pre-dispatch-failure'`.
- A dispatch error is classified `pre-dispatch-failure` only when the adapter knows worker start was
  never invoked. Once start may have occurred, the result remains `indeterminate`; the capability
  does not turn asynchronous uncertainty into a clean refusal.
- Remote reads time out at 15s. A command sent as the connection drops is reported
  **indeterminate** — it may or may not have taken effect — rather than as a clean failure.
- A dropped subscription marks the mirror unreachable and retries every second; until it recovers the
  row shows _Host unreachable_, and detail falls back to the last cached read if there is one.

## State on disk, and resetting

| What                                                                          | Where                                                                                                                                                        |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Kernel DB (enrollments, ledger, tick traces, terminal summaries — both kinds) | `<profile>/fork-heimdall/heimdall.db` (`database.ts:187`)                                                                                                    |
| Objective plans and reports                                                   | `<profile>/fork-heimdall-objective/objective.db`                                                                                                             |
| Workspace lease holder                                                        | Git: `<absolute-git-dir>/orca-heimdall/lease/epoch-<n>/holder.json`; folder: `<workspace>/.orca/heimdall/lease/epoch-<n>/holder.json`, on the execution host |

`<profile>` is the Electron userData directory: `~/Library/Application Support/orca-dev` under
`pnpm dev`. To reset, quit the app first. Heimdall's asynchronous shutdown joins Electron's quit
barrier: it stops new work, gives active operation tails up to 1.5 seconds while retaining their
leases, then releases with the remaining deadline before closing storage. The bound keeps quit from
hanging, so it is not a promise that every in-flight asynchronous effect or lease release finishes;
an interrupted lease still self-heals after its TTL.

```sh
rm -rf ~/Library/Application\ Support/orca-dev/fork-heimdall \
       ~/Library/Application\ Support/orca-dev/fork-heimdall-objective
```

Leave `orchestration.db` alone — orphaned run rows are inert and it holds unrelated state.

## Debugging

Use **Copy debug report** in the watcher detail header, or the CLI:

```sh
orca heimdall debug <watcherId>
orca heimdall debug <watcherId> --out watcher-debug.json
```

The CLI addresses watchers owned by the connected local kernel; use the fleet detail button for
watchers owned by a paired runtime. Output is JSON, including when `--json` is omitted.

Schema 2 includes enrollment, status, budget and open budget interval, recent ledger and tick
traces, pending control operations, malformed enrollment state, orchestration workers, and live
runner state that is lost on restart: stop/suspend flags, recovery state, lease renewal, queued
work, and the last snapshot's identity, freshness and kind-provided summary. Raw snapshot bodies
are not included. A failed worker lookup is reported separately in `workersError`.

`pointers` names the kernel and kind databases, workspace, and cached lease-holder location.
Each pointer identifies its host: databases belong to `kernel`, workspace and lease paths to the
execution host. Kernel-local home directories collapse to `~`; remote paths remain unchanged.
Pointers are not statted or resolved over SSH: an unresolved pointer is not evidence that the file
or remote process is absent. Free-text ledger reasons and trace errors are sanitized, but pointer
paths are intentionally preserved. Review the report before sharing it.

The same report remains available through `await window.api.heimdall.debugReport(target)`.

Runtime breadcrumbs are `console.warn('[heimdall] …')` on failure paths only. There is no verbose or
debug log level, and no Heimdall-specific log environment variable.

## Troubleshooting

| Symptom                                                               | Cause                                                                              |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Second watcher refused on a workspace                                 | live lease; wait ~90s after an app crash, or find the other instance               |
| Sitter never leaves its first tick                                    | `gh` / `glab` not authenticated — reads happen regardless of capabilities          |
| Objective workers dispatch but never report                           | `out/cli` missing; run `pnpm build:cli`                                            |
| Attempt fails `observed-change-outside-write-territory`               | an agent wrote outside the declared globs — widen the territory or narrow the task |
| Nothing happens and the trace says `awaiting-approval`                | a `gated` capability is waiting for you in the detail pane                         |
| Watcher shows _Parked_, Resume is refused                             | budget spent — Apply budget first, then resume                                     |
| Watcher shows _Held_ but no escalation                                | read the decision trace's hold reason; most are interlocks, not errors             |
| Watcher parks with `configuration-error`                              | durable workspace or authority mismatch — repair it before Resume                  |
| "push target is unverifiable"                                         | zero or more than one remote matches the review's source repo                      |
| Sitter refuses to act on a dirty worktree                             | contention guard — commit, stash, or close the other agent in that worktree        |
| PR Sitter control missing entirely                                    | unsupported provider, detached HEAD, or no open review on the branch               |
| Objective replans forever, never dispatches                           | no default TUI agent on the owning host — set one, or pick explicit role agents    |
| Objective parks immediately on enrollment                             | turn budget set to 0                                                               |
| Objective proposes an action every tick but never acts, no escalation | that capability is **Off**, not Ask                                                |
| Two dev instances fighting                                            | shared `orca-dev` profile; isolate with `ORCA_DEV_USER_DATA_PATH`                  |

## A safe first run

1. **Sitter, all gates off.** Arm against a worktree with an open PR. It reads and decides but never
   acts. Watch the ledger, decision trace and status pill through one tick.
2. **One gate.** Re-arm with `updateBranch: gated`. An `awaiting-approval` escalation appears;
   approving it is what triggers the real push.
3. **Objective, last.** Landing bar `files-on-disk`, turn budget ~5, and a narrow write territory —
   the field is optional and a blank one gives the agents the whole workspace, so type globs in
   deliberately.
   Remember `implement` / `review` / `check` are `on` by default — the first tick spends money.

## Not yet proven

From the Phase 4 verification record (`tech-phase-4.md:41-52,1466-1483`):

- **Real forge calls.** Every test to date used a fake; `gh` / `glab` against a live PR is unproven.
- **The SSH / push rung.** The relay lane is unproven; filed as a test-skip in the orca ledger.
- **The remote sandbox suite never ran** in this worktree — no Docker host configured (`test-gap-124`).
- **No UI end-to-end coverage.** The only e2e file is a cross-version wire unit test.
- **Shutdown is bounded, not transactional across arbitrary async effects.** It joins the quit
  barrier and drains for up to 1.5 seconds, but an operation still outstanding at the deadline may
  require normal write-ahead recovery on restart.
