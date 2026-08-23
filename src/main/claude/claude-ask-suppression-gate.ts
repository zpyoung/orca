import { hasReachedAppVersion } from '../../shared/app-version'
import { tokenizeStartupCommand, type AgentStartupShell } from '../../shared/tui-agent-startup-shell'

// --append-system-prompt gained its interactive-session behavior in 1.0.51; --disallowedTools
// is older (0.2.82), so the pair floor is the newer flag's floor.
export const CLAUDE_ASK_SUPPRESSION_VERSION_FLOOR = '1.0.51'

// Why: suppress hot-loop re-probing of a broken host while still detecting an in-place Claude
// Code upgrade during a long Orca session, mirroring GitCapabilityCache's rationale.
export const CLAUDE_ASK_SUPPRESSION_GATE_RETRY_INTERVAL_MS = 30 * 60_000

export const CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_FLAG = '--disallowedTools'
export const CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE = 'AskUserQuestion'
export const CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_FLAG = '--append-system-prompt'
export const CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_VALUE =
  'When you need to ask the user a question, run the orca ask CLI (see the orca-ask skill) instead of asking in chat.'

const CLAUDE_ASK_SUPPRESSION_FLAGS = [
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_FLAG,
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_FLAG,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_VALUE
]

/** Runs the given argv to completion on one host and resolves its raw stdout.
 *  Rejects for an unresolvable command, a spawn failure, or a non-zero exit —
 *  every rejection path collapses to the gate's fail-open null. */
export type AskGateVersionProbe = (argv: readonly string[]) => Promise<string>

type AskGateHostIdentity =
  | { readonly kind: 'local'; readonly wslDistro?: string }
  | { readonly kind: 'ssh'; readonly sshProvider: object }

/** Identifies the host a managed Claude launch will run on and how to probe its
 *  effective binary's version. `commandOverride` mirrors `settings.agentCmdOverrides.claude`
 *  verbatim (including its falsy-means-unset semantics); `probe` is supplied by the caller
 *  because only it has the host-specific machinery to actually run a command there
 *  (native spawn, a WSL wrapper, or an SSH channel). */
export type AskGateHostKey = AskGateHostIdentity & {
  readonly shell: AgentStartupShell
  readonly commandOverride?: string
  readonly probe: AskGateVersionProbe
}

type AskGateHostRecord = {
  verdict?: string[] | null
  retryAfterMs?: number
}

/** Per-host verdict cache, modeled on CodexAppServerCapabilityCache: one resolved value per
 *  host, cached until cleared. A verdict for one host must never leak to another, so native
 *  hosts and WSL distros live in a string-keyed map (per git-capability-state.ts) while SSH
 *  hosts live in a WeakMap keyed by the caller's own provider object identity. */
export class ClaudeAskSuppressionGateCache {
  private readonly localRecords = new Map<string, AskGateHostRecord>()
  private sshRecords = new WeakMap<object, AskGateHostRecord>()

  recordFor(host: AskGateHostKey): AskGateHostRecord {
    if (host.kind === 'ssh') {
      let record = this.sshRecords.get(host.sshProvider)
      if (!record) {
        record = {}
        this.sshRecords.set(host.sshProvider, record)
      }
      return record
    }
    const key = host.wslDistro ? `wsl:${host.wslDistro}` : 'local'
    let record = this.localRecords.get(key)
    if (!record) {
      record = {}
      this.localRecords.set(key, record)
    }
    return record
  }

  clear(): void {
    this.localRecords.clear()
    this.sshRecords = new WeakMap()
  }
}

export const claudeAskSuppressionGateCache = new ClaudeAskSuppressionGateCache()

export function clearClaudeAskSuppressionGateForTests(): void {
  claudeAskSuppressionGateCache.clear()
}

function buildProbeArgv(host: AskGateHostKey): readonly string[] | null {
  if (!host.commandOverride) {
    return ['claude', '--version']
  }
  const tokenized = tokenizeStartupCommand(host.commandOverride, host.shell)
  return tokenized.ok && tokenized.tokens.length > 0 ? [...tokenized.tokens, '--version'] : null
}

/**
 * Decides whether a managed Claude Code launch should get the AskUserQuestion suppression
 * flags. Fail-open is the whole safety property: anything short of "read a version and it
 * cleared the floor" — below floor, an unresolvable/failing probe, unparseable output, or a
 * pending retry cooldown — returns null and never throws to the caller.
 */
export async function resolveClaudeAskSuppressionFlags(
  host: AskGateHostKey
): Promise<string[] | null> {
  const record = claudeAskSuppressionGateCache.recordFor(host)
  if (record.verdict !== undefined) {
    return record.verdict ? [...record.verdict] : null
  }

  const nowMs = Date.now()
  if (record.retryAfterMs !== undefined) {
    if (nowMs < record.retryAfterMs) {
      return null
    }
    record.retryAfterMs = undefined
  }

  try {
    const argv = buildProbeArgv(host)
    if (!argv) {
      record.retryAfterMs = nowMs + CLAUDE_ASK_SUPPRESSION_GATE_RETRY_INTERVAL_MS
      return null
    }
    const stdout = await host.probe(argv)
    const version = stdout.match(/\d+\.\d+\.\d+/)?.[0]
    if (!version) {
      record.retryAfterMs = nowMs + CLAUDE_ASK_SUPPRESSION_GATE_RETRY_INTERVAL_MS
      return null
    }
    if (hasReachedAppVersion(version, CLAUDE_ASK_SUPPRESSION_VERSION_FLOOR)) {
      record.verdict = CLAUDE_ASK_SUPPRESSION_FLAGS
      return [...record.verdict]
    }
    // below-floor stays retryable (unlike the sticky above-floor verdict) so an in-place upgrade is still caught
    record.retryAfterMs = nowMs + CLAUDE_ASK_SUPPRESSION_GATE_RETRY_INTERVAL_MS
    return null
  } catch {
    record.retryAfterMs = nowMs + CLAUDE_ASK_SUPPRESSION_GATE_RETRY_INTERVAL_MS
    return null
  }
}
