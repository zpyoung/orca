<!-- schema-version: 1 -->
<!-- BUGS.md SCHEMA (append only — do not rewrite existing entries)
Entry format:
## BUG-[N]: [Short title]
- **Observed**: [date or session ID]
- **File**: [path/to/file.ts:line]
- **Description**: [what the bug is]
- **Introduced by**: [this session / unknown / commit SHA]
- **Severity**: [critical / high / medium / low]
- **Proposed fix**: [one sentence]
- **Blocker for**: [what this would break]

Required fields: title, file, description, severity.
-->

# BUGS

Bugs noticed during sessions but not fixed in the current scope.

Reviewed every PR. Use `/quirk:artifacts:bug` to append. Do not edit older
entries' IDs; manual edits to fix typos are fine.

## BUG-1: Reattach quarantine armed on only one of four PTY-swap paths; composer sends bypass it entirely
- **Observed**: 2026-08-13
- **File**: src/renderer/src/components/terminal-pane/terminal-pane-recovery.ts:290
- **Description**: armTerminalInputQuarantine has exactly one call site (terminal-pane-recovery.ts:290, gated on endpointReplaced). SSH drop, remote-runtime reconnect, and the Codex detached-pane restart scheduler never arm reattach quarantine, so in-flight input can land on a freshly swapped PTY on those paths even for raw keystrokes — the exact hazard terminal-input-quarantine.ts was written to prevent. Native chat's send path additionally bypasses quarantine entirely (different write path; quarantine keys by tabId, sends queue by ptyId), and its delayed auto-submit Enter means a stale send needs no second human confirmation. Discovered during docked-composer design research; out of scope for that feature.
- **Severity**: high

## BUG-2: Environment-dependent failures in relay/ssh test suites on this dev host
- **Observed**: 2026-08-14
- **File**: src/relay/agent-exec-handler.test.ts:27
- **Description**: Four tests fail deterministically on this machine: agent-exec-handler 'executes a non-interactive command with captured output and stdin' and 'merges caller-supplied provider environment into the spawned command environment' (spawn-arg mock mismatches), git-handler 'rethrows upstreamStatus failures that are not no-upstream-configured' (host git returns 'Stopping at filesystem boundary (GIT_...)' instead of 'not a git repository' — host git config bleed), ssh-remote-commands 'bounds real POSIX GC output with more than the exec-cap stage population'. Verified identical failures on a clean worktree at merge-base 8dc672c4c0 (pre-branch), so not a warp-rich-input regression; likely host git/config/environment dependence in the tests.
- **Introduced by**: pre-existing on main (verified at 8dc672c4c0)
- **Severity**: low
- **Addendum (2026-08-14)**: project-view-wrapper-source-context-boundary 'builds project work items with a host-pinned repository identity' also failed (30s timeout) in a full-suite run on this host during the branch adversarial review; file untouched by warp-rich-input. Same environment/load class; not yet reproduced in isolation.


## BUG-3: Two suites fail deterministically on this dev host, unrelated to any branch change
- **Observed**: 2026-08-18
- **File**: src/shared/posix-command-path-lookup.test.ts:61
- **Description**: `buildPosixCommandPathLookupScript > resolves without mutating alias and function masks in zsh` resolves `node` through the host's zsh, which finds `/usr/local/Cellar/node/25.9.0_1/bin/node` while the test process runs the nvm node it asserts against (`process.execPath`) — a host PATH-ordering dependence, not a code defect. `terminal-ime-xterm-resumed-preedit-visibility.test.ts` fails two cases (`shown: false` vs `true`) for a preedit the IME resumes. Both fail in isolation and on a tree with the working changes stashed; no commit on warp-rich-input touches either area.
- **Introduced by**: pre-existing / environment
- **Severity**: low

## BUG-4: TerminalPane.tsx's terminal-dock wiring is undeclared in the fork-ownership manifest
- **Observed**: 2026-08-23
- **File**: config/fork-ownership.json
- **Description**: TerminalPane.tsx carries ~128 lines of fork-authored terminal-dock wiring (imports, useTerminalPaneDock, the dock-mount JSX block, focus-ownership call sites) but is declared only as an `exceptions` entry whose reason describes an unrelated upstream fix ("Corrects effectiveChatViewMode"). No `seams` entry names the dock lines, and `residuals` is schema-illegal for exception paths, so nothing records or bounds the dock footprint. The guard passes because an exception path is checked for existence only, never content — confirmed in .github/scripts/check-fork-ownership.mjs (checkStaleEntries is the only check that touches an exception path). The wiring has ridden this unrelated exception since bbfba96abc and survived the v1.4.186 and v1.4.187 syncs without ever being described. Consequence: a sync has no declared spec of what the dock wiring should look like, and any accidental loss of those lines is invisible to CI. Needs an owner decision — split the dock wiring into its own manifest entry, or restate the exception reason to cover the file's real fork footprint.
- **Severity**: medium
