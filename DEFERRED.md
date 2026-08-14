<!-- schema-version: 1 -->
<!-- DEFERRED.md SCHEMA (append only)
Entry format:
## DEFER-[N]: [Task title]
- **Deferred**: [date]
- **Session context**: [what triggered this]
- **Why deferred**: [out of scope / blocked on / requires decision]
- **Estimated effort**: [S/M/L]
- **Priority**: [P1/P2/P3/P4]
- **Proposed owner**: [Claude / name / unassigned]

Required fields: title, why_deferred, priority.
-->

# DEFERRED

Tasks surfaced during sessions but explicitly out of scope for the current work.

Reviewed every sprint planning. Use `/quirk:artifacts:defer` to append.

## DEFER-1: Terminal-dock focus: visibility-resume refocus ignores docked composer
- **Deferred**: 2026-08-14
- **Why deferred**: focusActivePane (pane-helpers.ts), called from terminal-visibility-resume.ts (x3) and use-terminal-pane-lifecycle.ts (x1) on tab/window visibility resume, does not check terminal-dock's docked-composer-owns-focus rule. Fixing it requires threading tabId/paneKey through ResumeTerminalVisibilityArgs and HideTerminalVisibilityArgs, which none of those call sites currently carry -- a refactor whose blast radius (multiple signatures in a file with its own large regression suite) was disproportionate to the T10 task budget. The 3 more clearly-scoped focus call sites in TerminalPane.tsx (mobile-restore x2, middle-click paste x1) were guarded instead.
- **Estimated effort**: M
- **Priority**: P3
- **Proposed owner**: terminal-dock feature owner

## DEFER-2: terminal-dock-pane-state.ts (localStorage) left unwired; unified-tab record used as sole source of truth
- **Deferred**: 2026-08-14
- **Why deferred**: terminal-dock-pane-state.ts exposes readTerminalDockPaneState/writeTerminalDockPaneState/removeTerminalDockPaneKeys (localStorage-backed, no synced-settings write) but T10 wires the dock exclusively off the unified tab's terminalDockByPaneKey record + setTabTerminalDockState/pruneTerminalDockPaneKeys (store-backed, host-mirrored), per the task's explicit contract wording. removeTerminalDockPaneKeys therefore still has zero callers after T10, same as before. If the localStorage module was meant to be the primary/fallback source (its own module comment claims the settings-write-avoidance rationale), a follow-up should either wire it in or delete it as dead code -- worth a design decision, not a T10-scope call.
- **Estimated effort**: S
- **Priority**: P3
- **Proposed owner**: terminal-dock feature owner

