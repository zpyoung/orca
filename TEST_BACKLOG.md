<!-- schema-version: 1 -->
<!-- TEST_BACKLOG.md SCHEMA (append only)
Entry format:
## TEST-[N]: [Function or behavior to test]
- **File under test**: [path]
- **Test type**: [unit / integration / e2e]
- **Reason skipped**: [time / complexity / mocking required / TBD]
- **Edge cases to cover**: [list]
- **Priority**: [P1/P2/P3/P4]

Required fields: file_under_test, reason_skipped.
-->

# TEST BACKLOG

Tests that were skipped, abbreviated, or flagged as needing expansion.

Reviewed every 2 weeks. Use `/quirk:artifacts:test-skip` to append.

## TEST-1: Load-sensitive tests that fail only under full-suite concurrency on this dev host
- **File under test**: src/main/updater.test.ts; src/rpc (terminal-output-frame-chunks-equivalence); src/renderer/src/components/github-project/project-view-wrapper-source-context-boundary.test.ts; src/renderer/src/components/right-sidebar (ai-vault-session-worktree-map); src/relay/subprocess.test.ts; src/main/providers (ssh-pty-provider-agent-session-create-operation); src/main/runtime/orchestration (orchestration-creator-authority-performance); src/shared/remote-runtime-shared-control-connection.test.ts; src/renderer/src/components/terminal-pane/terminal-fit-restore.test.ts; src/renderer/src/lib/palette-match/palette-match-performance.test.ts; src/main/providers (local-pty-shell-ready-zsh-zdotdir-discovery); src/cli/runtime/transport.test.ts; src/renderer/src/components/dashboard-popout (AgentMapWorkspaceContextMenu)
- **Test type**: unit / integration
- **Reason skipped**: environment — each passes in isolation on the warp-rich-input branch but intermittently times out or misses a fake-timer tick under full-suite load on an 8-core host (worker-pool contention; one case surfaced a 14999-vs-15000ms fake-timer bleed). None are touched by the branch; verified against RUN_BASE b84a7492 during the docked-composer run (2026-08-13..16). Re-confirmed 2026-08-25 on the composer-open-by-default branch against the remote sandbox: `--shards=16 --jobs=8` failed 15/16 shards across 45 files, `--jobs=4` failed 4/16 across 7 tests, and every checked file passed at `--jobs=1` — the failure count tracks concurrency, not the diff.
- **Edge cases to cover**: make the timeout-bound assertions load-tolerant (fake timers pinned per test, generous poll budgets), or isolate these files into a serial pool so full-suite runs stop reporting noise
- **Priority**: P3

## TEST-2: browser-cookie partition electron tests fail only under full-suite concurrency
- **File under test**: src/main/browser/browser-cookie-import-partition.electron.test.ts; src/main/browser/browser-cookie-import-partition-rollback.electron.test.ts
- **Test type**: integration
- **Reason skipped**: environment — both fail in a full `pnpm test` run on this 8-core host but pass in isolation on this branch, and pass in isolation at origin/main (33096f51b3). Same worker-pool contention class as TEST-1; neither file is touched by the warp-rich-input branch. Observed while verifying the rebase onto origin/main.
- **Edge cases to cover**: make the Electron cookie-clear assertions load-tolerant, or move the `.electron.test.ts` files into a serial pool
- **Priority**: P3

## TEST-3: No component-level harness proves a same-id reattach re-renders the dock
- **File under test**: src/renderer/src/components/terminal-pane/TerminalPane.tsx
- **Test type**: component / integration
- **Reason skipped**: no TerminalPane.test.tsx exists anywhere in the repo, and nothing renders <TerminalPane /> — the component owns a PaneManager, xterm instances, and the deferred connect loop, so standing one up is a harness project, not a test. The stale-dock fix is anchored instead by unit tests on the fork hook (use-terminal-dock-pty-binding-revision.test.ts, use-terminal-pane-dock.test.ts) plus the upstream contract test that proves the chokepoint fires on remount (pty-connection-reattach-binding.test.ts:173). The seam those three leave uncovered is the wiring itself: that TerminalPane's syncPanePtyLayoutBinding/clearExitedPanePtyLayoutBinding actually call the notifier. Verified manually in the Electron app instead.
- **Edge cases to cover**: generation remount, tab-move rehome and web-mirror remount all reattach to the id the layout already holds; pty exit clears the dock without a toggle; multi-pane splits where one pane rebinds and siblings do not
- **Priority**: P3

## TEST-4: No hook-level harness covers the handoff dialog's template-save selection rule
- **File under test**: src/renderer/src/components/agent-session-continuation/fork-session-handoff/use-handoff-dialog-state.ts:363
- **Test type**: unit / component
- **Reason skipped**: no test file renders `useHandoffDialogState` — `AgentSessionContinuationDialog.test.tsx` mocks the hook wholesale, so the hook has zero coverage today. It reads the app store through three `useAppStore` selectors plus `getState`, and drives capture, target resolution, secret scanning, and draft preservation, so a `renderHook` harness means standing up a full store fixture and mocking eight modules. The values a freshly opened dialog starts from are now covered by `handoff-dialog-open-seed.test.ts`, and the BUG-6 fix is anchored by `HandoffNotesControls.test.tsx` on the component side. What stays unproven is the wiring: that the render-time seeding runs on the open transition and not on unrelated re-renders, and that the newly saved template is adopted only when nothing was selected.
- **Edge cases to cover**: save with a template already selected (prior selection and steering note both survive); save with no template selected (new template is adopted and the note clears); a save that resolves after the generation ref advanced changes nothing
- **Priority**: P3
