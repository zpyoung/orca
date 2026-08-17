/** Points an `agentCmdOverrides` entry at the stub agent runner instead of a real CLI. */

import { join } from 'node:path'

export function resolveStubAgentRunnerPath(): string {
  return join(__dirname, 'stub-agent-runner.cjs')
}

// Set on a launch's env to make the runner wait for a pasted prompt on stdin instead of
// reading one from argv — the shape a real orchestrated dispatch launch actually takes
// (see stub-agent-runner.cjs). The runner is a standalone .cjs and can't import this, so its
// copy of the literal must be kept in sync by hand.
export const STUB_AGENT_AWAIT_PASTE_ENV_VAR = 'ORCA_STUB_HARNESS_AWAIT_PASTE'

// Why double-quoting: this string is parsed as a shell command line (POSIX, cmd, or
// PowerShell — see tui-agent-startup-shell.ts) before the prompt argv is appended, and a
// control directory under the OS temp path can contain spaces (e.g. Windows profile paths).
export function buildStubAgentCmdOverride(controlDir: string): string {
  return `node "${resolveStubAgentRunnerPath()}" "${controlDir}"`
}
