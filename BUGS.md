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

