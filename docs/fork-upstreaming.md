# Fork upstreaming ledger

Tracks fork-authored changes to upstream files that belong in upstream rather than isolated as a
fork feature — Tier 4 in `config/fork-ownership.json`. Each entry states what changed, why it
should not simply be isolated, the paths it spans, and its current status. An entry and its
manifest `exceptions[]` row (`status: "pending-upstream"`, `ledger` pointing at that entry's
anchor) are created and removed together — see `config/scripts/fork-ownership-manifest.mjs` for
the invariant this enforces.

## POSIX lookup test startup isolation

**What:** runs the zsh lookup case with `-f` so user startup files cannot replace the fixture
PATH. The existing alias/function-mask regression uses a temporary executable and a controlled
`.zshenv` that overwrites PATH, making the failure reproducible on clean sandbox hosts.

**Why upstream, not isolated:** this fixes upstream test isolation, not shipped lookup behavior.
The existing suite should remain the single source of coverage.

**Paths:** `src/shared/posix-command-path-lookup.test.ts`.

**Orca ledger:** `bug-3`.
## Git multiline diagnostics

**Ledger:** bug-47.

**What:** preserves Git's diagnostic block from the last `fatal:` or `error:` line,
including continuation lines such as the filesystem-discovery explanation. Command
wrappers and preceding progress output remain excluded, credentials remain redacted,
and unprefixed failures retain the last-nonempty-line fallback.

**Why upstream, not isolated:** this corrects the existing shared normalizer used by
local and SSH Git operations, including non-repository folder workspaces. A forked
copy would duplicate the same error policy. No Git command or wire schema changes;
older clients continue to receive an ordinary error string.

**Paths:**

- `src/shared/git-remote-error.ts`
- `src/shared/git-remote-error.test.ts`

**Status:** pending-upstream. Not yet submitted.

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
- `src/renderer/src/components/sidebar/worktree-header-section-boundaries.test.ts`
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
rule runs at `warn`. `react-doctor/effect-needs-cleanup` is stranger still: it _is_ on that list at
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
- `src/renderer/src/components/browser-pane/annotate/browser-page-annotation-tray.tsx`

The `package.json` severities need no `exceptions` row of their own; the file is already declared
`permanent`.

The v1.4.193 sync added the last three. The first two are the same shape as the originals — a
`node:buffer` import and a template literal, on lines the merge touched. The third is different in
kind: `use-checks-list-state.tsx` wrote `autoExpandedContextRef` _inside_ a `setExpandedCheckKeys`
updater, and React may run an updater more than once, so the write is hoisted into the effect that
queues it. That one is a genuine correctness fix to upstream's hook and worth submitting on its own
merits, not just to clear the gate.

**Introduced:** the v1.4.186 sync (2026-08-21), fixing the `static analysis` job on PR #12.
The v1.4.193 sync added the last two severities. That release lands a new 48-file
`right-sidebar/checks-panel/` subsystem, so every line in it is a changed line and the CLI reported
20+ findings there under those two rules. Upstream's own `package.json` downgrades neither, and the
CLI's rule set has moved since upstream merged that code, so upstream `main` would fail this gate
today as well — the findings are upstream's to resolve, not the fork's to rewrite blind.

The v1.4.195 sync added `browser-page-annotation-tray.tsx`. v1.4.195 introduced the annotation
edit tray whole, so every line in it is a changed line, and its effect that clears
`editingAnnotationId` when the annotation leaves the `browserAnnotations` prop trips
`no-adjust-state-on-prop-change`. Adjusting the same state during render is the pattern React
documents for this, it is what the repo already does elsewhere (the composer core's scope-key
reset), and it removes a frame the tray would otherwise paint still in edit mode for an annotation
that is already gone — a small correctness gain, not just gate appeasement.

**Status:** pending-upstream. Not yet submitted. Drop any entry upstream resolves on its own — the
CLI's rule set moves independently of the pinned `react-doctor@0.9.1` version.

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

- `src/main/rate-limits/service/service-fetch-policy.ts` — declared in `seams`, not `exceptions`,
  since v1.4.186 split the service; the manifest therefore carries no `ledger` back-pointer for it.

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

## Git diff request cancellation

**Ledger:** `bug-12`.

**What:** repository probes carry their abort signal through the renderer, token-scoped
`git:cancelDiff` IPC, runtime RPC, SSH transport, and host-side Git blob reads. Closing or
retargeting a handoff must cancel the diff request, not merely discard its eventual result.
Cancellation is scoped to the requesting sender and must not stop unrelated diff consumers.

**Why upstream, not isolated:** the missing cancellation spans upstream's existing Git diff
API and subprocess execution path. Forking those modules would duplicate the Git transport
and execution stack; adding optional cancellation to the existing path preserves callers
that do not supply a signal.

**Paths:**

- `src/renderer/src/runtime/runtime-git-diff-client.ts`
- `src/renderer/src/web/preload-api/web-git-api.ts`
- `src/preload/api/git-bridge.ts`
- `src/preload/api/git-inspection-api.ts`
- `src/main/ipc/filesystem.ts`
- `src/main/ipc/filesystem/filesystem-handler-context.ts`
- `src/main/ipc/filesystem/filesystem-git-status-handlers.ts`
- `src/main/providers/git-provider-contract.ts`
- `src/main/providers/ssh-git-read-provider.ts`
- `src/main/runtime/runtime-git-diff-commands.ts`
- `src/main/runtime/rpc/methods/git-diff-methods.ts`
- `src/main/git/command-runner/git-exec-file.ts`
- `src/main/git/source-control/git-read-cache-invalidation.ts`
- `src/main/git/source-control/file-diff.ts`
- `src/main/git/source-control/git-blob-read.ts`
- `src/main/git/source-control/submodule-paths.ts`
- `src/relay/git-handler-operation-context.ts`
- `src/relay/git-handler.ts`
- `src/relay/git-handler-ops.ts`
- `src/relay/git-handler-read-operations.ts`
- `src/relay/git-handler-submodule-ops.ts`

**Regression coverage:**

- `src/main/ipc/filesystem-git-status-staging.test.ts`
- `src/main/providers/ssh-git-provider-diff.test.ts`
- `src/main/runtime/rpc/methods/git.test.ts`
- `src/main/runtime/orca-runtime-git-diff-budget.test.ts`
- `src/relay/git-handler-diff-read-coalescing.test.ts`
- `src/main/runtime/runtime-rpc-mobile-method-allowlist.test.ts`
- `src/main/runtime/rpc/methods/git-diff-transport-budget.test.ts`
- `src/main/git/status-submodule-path-cache.test.ts`
- `src/relay/git-handler-submodule-ops.test.ts`
- `src/main/git/status-diff-settled-cache.test.ts`
- `src/renderer/src/web/web-preload-api-git.test.ts`

The handoff caller and its cancellation regression remain in the existing
`fork-session-handoff` feature.
Cancelled submodule discovery is not cached as an empty result, so an immediate retry
retains the correct submodule diff route.

**Compatibility:** reuse existing RPC cancellation and stream teardown; do not add a wire
opcode or require a new field from older peers. Cancellation of host subprocesses requires
the host-side fix as well as the caller-side signal.
## bug-35

**What:** the macOS press-and-hold startup routine treated only `com.stablyai.orca` and its
dot-children as Orca preference domains. The fork ships its packaged app as `com.zpyoung.orca`, so
the routine recorded `foreign-bundle` and never applied the key-repeat default. The ownership check
now accepts both exact namespace roots and their dot-children. Unit coverage pins both namespaces
and rejects lookalike or unrelated identifiers; the startup E2E recognizes either packaged
identity, and the reference commands use the fork's shipped domain.

An earlier `foreign-bundle` record needs no migration or deletion. It is a non-terminal decision,
so startup already retries it on every launch and applies the default once the packaged fork domain
is recognized.

**Why upstream, not isolated:** the domain gate is part of upstream's startup routine and shares its
one-time record, explicit-user-value preservation, and conservative `defaults(1)` failure handling.
Forking that routine merely to add one owned namespace would duplicate the safety-critical state
machine. The narrow two-root allowlist changes no other identity policy: the upstream/development
namespace remains accepted, and only exact roots or dot-delimited children qualify.

**Paths:**

- `src/main/macos-press-and-hold-default.ts`
- `src/main/macos-press-and-hold-default.test.ts`
- `tests/e2e/macos-press-and-hold-startup.spec.ts`
- `docs/reference/macos-press-and-hold.md`

**Depends on:** the fork's packaged app ID is `com.zpyoung.orca`; upstream and development builds
continue to use `com.stablyai.orca` or a dot-suffixed child.
## Draft RC recovery recognizes fork tags

**What:** the interrupted-release publisher accepts both upstream RC tags
(`vMAJOR.MINOR.PATCH-rc.N`) and the fork's corresponding release tags with exactly one optional
`.zyNN` suffix. Its tests preserve the bot-authored draft gate, reject malformed suffixes, exercise
current and stale upstream and fork tags, and prove through the real required-asset verifier that an
artifact-less draft remains private.

**Ledger:** `bug-14`, repaired together with `bug-48` in the fork-owned release workflow.

**Why upstream, not isolated:** candidate recognition is one predicate inside upstream's existing
recovery publisher, ahead of its current-ref and asset-completeness safety gates. Isolating the
predicate would require a forked publisher or a parallel pre-filter that can drift from those
guards; the narrowly anchored optional suffix preserves upstream's tag behavior while recognizing
the fork's release identifier.

**Paths:**

- `config/scripts/publish-complete-draft-releases.mjs`
- `config/scripts/publish-complete-draft-releases.test.mjs`
## Reattach input quarantine

**Ledger:** `bug-1`.

**What:** arms terminal-tab input quarantine before a remote pane binds a replacement shell.
An ordinary provider-handle rotation with the same shell remains unquarantined. Host-pane
recovery arms it in the transport that issued the `terminal.recoverPane` call, so missing
incarnation metadata or a handle an older host reuses cannot bypass the guard; the rebind
callback and the remote wire protocol are both unchanged.

Native-chat eligibility and runtime sends also honor that tab's quarantine. Reattachment
invalidates queued bodies, paced answers, and delayed submit writes rather than replaying them
when quarantine expires. Cancellation must not write cleanup bytes into the replacement shell.

**Why upstream, not isolated:** both defects cross existing upstream terminal binding and
native-chat write boundaries. A parallel binding or send implementation would leave callers
able to bypass the safety guard. The existing fork composer is updated at the same boundary;
new quarantine-specific logic and regressions live under `fork-input-quarantine/`.

**Paths:** the `bug-1` exceptions in `config/fork-ownership.json` cover the terminal transport,
PTY binding, native-chat eligibility, send queue, and migrated consumers/tests. The
`input-quarantine` feature owns its isolated logic and regressions; existing composer changes
remain under the `agent-composer` feature.

**Status:** pending-upstream. Not yet submitted.
