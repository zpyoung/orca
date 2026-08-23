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

## Chat header controls fix

**What:** `TerminalPane.tsx` gates `activePaneIsChatLeaf` on `effectiveChatViewMode` rather than
`isChatViewMode`. With the experimental native-chat flag off, a tab can still carry
`viewMode: 'chat'`, and the header must not offer chat-only controls while the chat surface itself
is suppressed.

**Why upstream, not isolated:** a correctness fix to upstream's own chat/terminal header-control
gating, unrelated to any of the fork's four features (it landed inside the `native-chat-width`
feature commit as an incidental fix, not width functionality).

**Paths:**
- `src/renderer/src/components/terminal-pane/TerminalPane.tsx`

**Introduced:** commit `9ac7e7c423` (2026-08-06), "feat(native-chat): configurable reading-column
width" (the fix rode in on this commit; it is not part of the width feature itself).

**Status:** pending-upstream. Not yet submitted.

## Workspace session schema split

**What:** the persisted-open-file schemas move out of `workspace-session-schema.ts` into a new
`workspace-session-editor-schema.ts`, which the original then imports. No schema changes — the
`persistedOpenFileSchema` object is byte-identical, only relocated.

**Why upstream, not isolated:** `workspace-session-schema.ts` sits at 299 code lines against a
300-line cap, so the terminal-dock feature's two seam lines (a fork import and one `tabSchema`
field) do not fit without a split. The split itself is upstream's own file being reorganized, and
the extracted module holds no fork content — isolating it into a `fork-` directory would put
upstream code under a fork glob and hand the fork permanent ownership of a schema it did not write.

**Paths:**
- `src/shared/workspace-session-editor-schema.ts`

**Introduced:** commit `e63c56e90c` (2026-08-18), "fix(composer): reintegrate the codex typed-command
send after the rebase onto main".

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

`react-doctor/no-ref-current-in-render` and `react-doctor/no-effect-with-fresh-deps` default to
`error` in the CLI but are absent from `config/oxlint-react-doctor.json`, the repo's curated React
Doctor rule list, where every listed rule runs at `warn`. Both fire only on deliberate,
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

The `package.json` severities need no `exceptions` row of their own; the file is already declared
`permanent`.

**Introduced:** the v1.4.186 sync (2026-08-21), fixing the `static analysis` job on PR #12.

**Status:** pending-upstream. Not yet submitted. Drop any entry upstream resolves on its own — the
CLI's rule set moves independently of the pinned `react-doctor@0.9.1` version.
