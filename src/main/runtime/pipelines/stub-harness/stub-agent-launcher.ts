/** Points an `agentCmdOverrides` entry at the stub agent runner instead of a real CLI. */

import { join } from 'node:path'

export function resolveStubAgentRunnerPath(): string {
  return join(__dirname, 'stub-agent-runner.cjs')
}

// Why double-quoting: this string is parsed as a shell command line (POSIX, cmd, or
// PowerShell — see tui-agent-startup-shell.ts) before the prompt argv is appended, and a
// control directory under the OS temp path can contain spaces (e.g. Windows profile paths).
export function buildStubAgentCmdOverride(controlDir: string): string {
  return `node "${resolveStubAgentRunnerPath()}" "${controlDir}"`
}
