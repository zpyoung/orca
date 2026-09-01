# Fork upstreaming ledger

Tracks fork-authored changes to upstream files that belong in upstream rather than isolated as a
fork feature — Tier 4 in `config/fork-ownership.json`. Each entry states what changed, why it
should not simply be isolated, the paths it spans, and its current status. An entry and its
manifest `exceptions[]` row (`status: "pending-upstream"`, `ledger` pointing at that entry's
anchor) are created and removed together — see `config/scripts/fork-ownership-manifest.mjs` for
the invariant this enforces.

## Retention fix

**What:** `useNativeChatRetainedSession` blanks a retained transcript while a fresh read is
loading, even when the pane already has content from a prior successful read. The fix excludes
the `error` status from the loading-state gate, and threads a `loading` flag through
`native-chat-transcript-retention.ts` so the retained messages stay visible during a refetch.

**Why upstream, not isolated:** this is a correctness fix to upstream's own retention behavior, not
fork-specific functionality. Isolating it would leave upstream carrying the blanking bug
indefinitely while the fork carries a parallel, diverging copy of the same hook.

**Paths:**

- `src/renderer/src/components/native-chat/use-native-chat-retained-session.ts`
- `src/renderer/src/components/native-chat/use-native-chat-retained-session.test.ts`
- `src/shared/native-chat-transcript-retention.ts`
- `src/shared/native-chat-transcript-retention.test.ts`

**Introduced:** commit `6d7f5bc116` (2026-08-10), "fix(native-chat): stop retention blanking live
transcript appends".

**Excluded when preparing the upstream PR:** `use-native-chat-retained-session.ts` and its test
also carry the native-chat-relay SSH-identity line `args.sshConnectionId ?? null,` and its two-line
explanatory comment, added by commit `c137a9e97d`. `sshConnectionId` is a fork-only field with no
upstream counterpart, so a PR built from this ledger entry must drop that line (and the test cases
exercising it) or it will not compile against upstream's tree.

**Status:** pending-upstream. Not yet submitted.

## Sidebar density

**What:** tightens the left-panel workspace list — virtualized row gap 6px → 2px, workspace-card
padding, and section-header height 28px → 24px — plus the two fixes the tighter layout surfaced:
the host-header row-height estimate corrected to match its rendered height (row-below overlap at
the smaller gap), and the repo-header action-button focus ring inset so the shorter header row's
`overflow-hidden` no longer clips it. Two lines of this change live inside the `worktree-groups`
seam declaration for `WorktreeList.tsx`; its other diffs are Tier-1 fork content, so the density
lines are folded into that seam rather than given a separate `exceptions` row for the same path.

**Why upstream, not isolated:** a density/spacing preference with no logic dependency on any fork
feature; isolating a cosmetic tweak like this only doubles the maintenance surface for something
upstream could take outright.

**Paths (own `exceptions` rows):**

- `src/renderer/src/components/sidebar/repo-header-action-button-class.ts`
- `src/renderer/src/components/sidebar/worktree-list/viewport/virtual-rows.ts`
- `src/renderer/src/components/sidebar/worktree-list/viewport/scroll-adjustment.test.ts`
- `src/renderer/src/components/sidebar/project-group-header-drop.test.ts`
- `src/renderer/src/components/sidebar/project-header-drop.test.ts`
- `src/renderer/src/components/sidebar/worktree-card-surface.tsx`

**Paths (density lines folded into the `worktree-groups` seam declaration):**

- `src/renderer/src/components/sidebar/WorktreeList.tsx` (2 lines)

**Introduced:** commit `7436d38a21` (2026-07-25), "style(sidebar): tighten workspace list spacing
and density".

**Status:** pending-upstream. Not yet submitted.

## React Doctor changed-lines gate

**What:** three one-line rewrites in files v1.4.186 introduced — two `Array<T>` uses become `T[]`,
and one Vitest test imports `Buffer` from `node:buffer` — plus two rule severities added to the
`reactDoctor` key in `package.json`.

The `Enforce React Doctor on changed lines` job runs the `react-doctor` CLI, which reads neither
`.oxlintrc.json` nor `config/oxlint-react-doctor.json`, so it blocks lines those configs
deliberately allow. `mobile/.oxlintrc.json` turns `typescript/array-type` and
`unicorn/prefer-node-protocol` off for the whole mobile package; the three rewrites simply satisfy
both configs at once, since Metro — the reason mobile avoids the `node:` protocol — never bundles a
test file.

`react-doctor/no-ref-current-in-render`, `react-doctor/no-effect-with-fresh-deps` and
`react-doctor/no-prop-callback-in-render` default to `error` in the CLI but are absent from
`config/oxlint-react-doctor.json`, the repo's curated React Doctor rule list, where every listed
rule runs at `warn`. `react-doctor/effect-needs-cleanup` is stranger still: it *is* on that list at
`warn`, so the CLI running it at `error` contradicts the severity the repo declares for it. Both fire only on deliberate,
upstream-authored patterns: latest-value refs written during render, a render-phase array-identity
cache, and test harnesses whose inline ref literals are the fixture under test. Setting them to
`warn` in `package.json` aligns the CLI with the severity the repo already declares, and keeps the
findings visible in the report instead of silencing them.

Inline `oxlint-disable` is not an option here: `check:code-quality:changed` runs Oxlint with
`--report-unused-disable-directives-severity warn`, and a directive naming a rule that Oxlint has
not loaded counts as unused, so every added directive becomes a finding in that gate instead.

**Why upstream, not isolated:** the findings are on upstream's own code, and `package.json` is
already a permanent fork exception. Isolating would mean forking nine upstream modules — four of
them hot sidebar hooks — and rewriting ref patterns upstream has no reason to change.

**Paths:**

- `mobile/src/browser/mobile-browser-frameless-stream.test.tsx`
- `mobile/src/session/pending-terminal-handle-recovery.test.ts`
- `mobile/src/transport/mobile-relay-rpc-session-liveness.test.ts`
- `mobile/src/browser/mobile-browser-frame-state.ts`
- `mobile/src/diagnostics/connection-diagnostics-submission.ts`
- `src/renderer/src/components/right-sidebar/checks-panel/use-checks-list-state.tsx`

The `package.json` severities need no `exceptions` row of their own; the file is already declared
`permanent`.

The v1.4.193 sync added the last three. The first two are the same shape as the originals — a
`node:buffer` import and a template literal, on lines the merge touched. The third is different in
kind: `use-checks-list-state.tsx` wrote `autoExpandedContextRef` *inside* a `setExpandedCheckKeys`
updater, and React may run an updater more than once, so the write is hoisted into the effect that
queues it. That one is a genuine correctness fix to upstream's hook and worth submitting on its own
merits, not just to clear the gate.

**Introduced:** the v1.4.186 sync (2026-08-21), fixing the `static analysis` job on PR #12.
The v1.4.193 sync added the last two severities. That release lands a new 48-file
`right-sidebar/checks-panel/` subsystem, so every line in it is a changed line and the CLI reported
20+ findings there under those two rules. Upstream's own `package.json` downgrades neither, and the
CLI's rule set has moved since upstream merged that code, so upstream `main` would fail this gate
today as well — the findings are upstream's to resolve, not the fork's to rewrite blind.

**Status:** pending-upstream. Not yet submitted. Drop any entry upstream resolves on its own — the
CLI's rule set moves independently of the pinned `react-doctor@0.9.1` version.

## Composer file-drop pane scoping

**What:** a native OS file drop on a composer is broadcast to every renderer subscriber, and
`useNativeChatFileAttachmentActions` took any payload whose target was `composer` — so one drop
attached to every mounted composer. `NativeFileDropPayload`'s `composer` variant now carries the
optional `tabId` / `paneLeafId` its `terminal` sibling already had, `resolveNativeFileDropPath`
returns them from the composer branch, and the hook ignores a drop addressed to a different
composer. A payload carrying neither id is still accepted, so a producer that cannot resolve pane
identity keeps working.

**Why upstream, not isolated:** this is a correctness fix to upstream's own drop routing, and the
payload shape is upstream's shared contract that preload, main, and every drop consumer read.
Isolating it would mean a forked copy of the shared type that upstream's own consumers still
bypass, leaving the mis-routing in place for every non-composer surface.

**Paths:**

- `src/shared/native-file-drop.ts`
- `src/renderer/src/components/native-chat/use-native-chat-file-attachment-actions.ts`
- `src/shared/native-file-drop.test.ts`
- `src/renderer/src/components/native-chat/use-native-chat-file-attachment-actions.test.tsx`

**Depends on:** the composer emits its own identity via `data-terminal-tab-id` /
`data-terminal-pane-leaf-id` on the drop-target div in
`src/renderer/src/components/native-chat/fork-agent-composer/AgentComposerField.tsx`, which is
fork-owned. An upstream PR built from this entry must move those two attributes onto upstream's
equivalent composer field, or the ids never reach `resolveNativeFileDropPath` and every drop stays
unaddressed (accepted everywhere, exactly as before).

**Status:** pending-upstream. Not yet submitted.

## Pane paste routing by focus

**What:** `useNativeChatPasteBridge` resolved the app-menu Paste target by asking which one was
mounted — composer first, the question card's answer input only as a fallback. It now prefers the
answer input whenever that input holds focus, and falls back to the mount-order rule otherwise.

**Why upstream, not isolated:** the old rule is only safe because `NativeChatView` unmounts the
composer while a question card is up, so the two targets are mutually exclusive there. That is an
invariant of one host, not of the bridge, and the bridge is the shared thing every host calls. A
host that legitimately keeps its composer mounted beside a card — the fork's terminal dock does,
because the card is an overlay above a gutter the composer still occupies — sends every Paste into
the composer and starves the focused answer input. Forking a copy of the bridge would leave the
same trap set for the next host upstream adds.

The DOM paste path is deliberately unchanged: `handlePaste` intercepts only clipboard images and
lets text fall through to the focused control, so an image pasted at the answer input keeps
attaching to the composer beside it instead of being dropped on the floor.

The app-menu path has no event to inspect, so it reads the clipboard as text and treats an empty
read as the image signal: with the answer input focused, empty text hands the paste to the mounted
composer's `pasteFromClipboard`, which is what knows how to save and attach an image. Without that
fallback an image-only Cmd+V at the answer input would be claimed and then silently discarded.

**Paths:**

- `src/renderer/src/components/native-chat/use-native-chat-paste-bridge.ts`
- `src/renderer/src/components/native-chat/use-native-chat-paste-bridge.test.tsx`

**Depends on:** nothing upstream-side. The fork's dock supplies the answer-input ref from
`src/renderer/src/components/terminal-pane/fork-terminal-dock/TerminalDock.tsx`; upstream's own
caller passes the same ref it already had, so the change is inert for `NativeChatView` and only
takes effect for a host that mounts both targets at once.

**Status:** pending-upstream. Not yet submitted.

## Live Claude rate-limit ingest acceptance

**What:** `RateLimitService.ingestLiveClaudeRateLimits` returns whether a statusline payload was
attributed to the selected Claude account and contained usable plan-window data. A deduplicated
payload still returns `true` because the existing live-session snapshot already represents it;
missing auth context, account mismatches, and empty windows return `false`.

**Why upstream, not isolated:** acceptance is decided by the service's private selected-account
snapshot, window parser, and dedupe state. A parallel fork wrapper cannot know whether the service
dropped a payload without duplicating those internals and risking a different attribution verdict.
Returning the decision lets any consumer correlate related pane telemetry without exposing account
paths or weakening the existing wrong-account guard.

**Paths:**

- `src/main/rate-limits/service.ts`

**Depends on:** the fork-owned Session Info correlation adapter in
`src/main/fork-session-info/session-info-plan-window-correlation.ts` consumes the result. An
upstream PR can test and land the return contract without that consumer.

**Status:** pending-upstream. Not yet submitted.

## Changed-lines type-aware scan reaches into mobile/

**What:** the `type-aware code quality` scan in `config/scripts/check-changed-code-quality.mjs` no
longer runs over changed files under `mobile/`.

**Why upstream, not isolated:** the scan pins `config/oxlint-code-quality-type-aware.json`, and the
comment on the sibling scan directly above it already states why that is wrong — pinning the root
config applies root rules to `mobile/`, which has its own workspace, lockfile and `.oxlintrc.json`.
`mobile/node_modules` is not installed in the job that runs this gate, so every React Native and
`react-test-renderer` type resolves as an `error` type and `typescript/no-redundant-type-constituents`
fires on the resolution failure rather than on the code. The full-tree audit that owns this rule set
(`pnpm run audit:code-quality:type-aware`) already scopes itself to `src config tests`, so `mobile/`
was never in the intended scope; only the changed-lines gate leaked into it.

The bug is latent for upstream and only surfaces on a PR whose diff adds lines to a `mobile/` test:
v1.4.194 added `mobile/src/session/use-mobile-terminal-inventory-recovery.test.ts`, and at least four
other pre-existing mobile files trip the same rule the moment their lines are touched.

Isolating is the wrong shape: this is one predicate inside upstream's own gate runner, and a forked
copy of the runner would have to be replayed on every release that touches it.

**Paths:**

- `config/scripts/check-changed-code-quality.mjs`

**Status:** pending-upstream. Not yet submitted.

## Structured session history page races the reap tombstone

**What:** the `create → send → stream → approval → cancel → reconnect → page history` case in
`src/main/runtime/structured-agent-session-integration.test.ts` awaits `drainStreamedEvents()` after
the runtime takeover, before it reads the first history page.

**Why upstream, not isolated:** the test asserts a durable-journal invariant, and the write it
depends on is asynchronous. `turn/started` appends the `turn-lifecycle:turn-1` status row
("Codex is working…"); the fake Codex never sends `turn/completed`, so that row is still live when
`agentSession.ensure` takes the session over. The reap runs `closeCodexPublishedSession`, whose
`ended` branch tombstones every running turn, and that tombstone goes through the deferred event
sink — writes queue and land on a promise chain that `agentSession.history` does not await. On an
unloaded machine the chain drains inside `ensure`'s remaining awaits and the page shows six rows; on
a loaded CI runner it does not, and the page still carries the status row at index 1:

```
- Expected            + Received
  [                     [
    "message",            "message",
                        +  "status",
    "message",            "message",
```

The barrier already exists and the test's own helper documents it — "Real clients see these rows
arrive on the subscription; a test has to wait for them" — the takeover path is the one place the
test reads the journal without it. Isolating is the wrong shape: this is one missing await inside
upstream's own test, and a forked copy would have to be replayed on every release that touches the
file.

**Paths:**

- `src/main/runtime/structured-agent-session-integration.test.ts`

**Status:** pending-upstream. Not yet submitted.
