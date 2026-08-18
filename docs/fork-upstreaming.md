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
seam declarations for `WorktreeCard.tsx` and `WorktreeList.tsx` (their own diffs are otherwise
Tier-1 fork content, so the density lines are folded into those seam entries rather than given a
separate `exceptions` row for those two files — a path cannot appear in both `seams` and
`exceptions`).

**Why upstream, not isolated:** a density/spacing preference with no logic dependency on any fork
feature; isolating a cosmetic tweak like this only doubles the maintenance surface for something
upstream could take outright.

**Paths (own `exceptions` rows):**
- `src/renderer/src/components/sidebar/repo-header-action-button-class.ts`
- `src/renderer/src/components/sidebar/worktree-list-virtual-rows.ts`
- `src/renderer/src/components/sidebar/worktree-list-scroll-adjustment.test.ts`
- `src/renderer/src/components/sidebar/project-group-header-drop.test.ts`
- `src/renderer/src/components/sidebar/project-header-drop.test.ts`

**Paths (density lines folded into the `worktree-groups` seam declaration):**
- `src/renderer/src/components/sidebar/WorktreeCard.tsx` (1 line)
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
