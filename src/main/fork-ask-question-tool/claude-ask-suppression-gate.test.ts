import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_FLAG,
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE,
  CLAUDE_ASK_SUPPRESSION_GATE_RETRY_INTERVAL_MS,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_FLAG,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_VALUE,
  clearClaudeAskSuppressionGateForTests,
  peekClaudeAskSuppressionFlags,
  resolveClaudeAskSuppressionFlags,
  type AskGateHostKey
} from './claude-ask-suppression-gate'

const expectedFlags = [
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_FLAG,
  CLAUDE_ASK_SUPPRESSION_DISALLOWED_TOOLS_VALUE,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_FLAG,
  CLAUDE_ASK_SUPPRESSION_SYSTEM_PROMPT_VALUE
]

function localHost(overrides: Partial<AskGateHostKey> = {}): AskGateHostKey {
  return {
    kind: 'local',
    shell: 'posix',
    probe: vi.fn().mockResolvedValue('1.0.51 (Claude Code)'),
    ...overrides
  } as AskGateHostKey
}

beforeEach(() => {
  clearClaudeAskSuppressionGateForTests()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('resolveClaudeAskSuppressionFlags', () => {
  it('injects the flags when the probed version is exactly at the floor', async () => {
    const host = localHost({ probe: vi.fn().mockResolvedValue('1.0.51') })
    await expect(resolveClaudeAskSuppressionFlags(host)).resolves.toEqual(expectedFlags)
  })

  it('injects the flags when the probed version is above the floor', async () => {
    const host = localHost({ probe: vi.fn().mockResolvedValue('1.2.0') })
    await expect(resolveClaudeAskSuppressionFlags(host)).resolves.toEqual(expectedFlags)
  })

  it('injects nothing when the probed version is below the floor', async () => {
    const host = localHost({ probe: vi.fn().mockResolvedValue('1.0.50') })
    await expect(resolveClaudeAskSuppressionFlags(host)).resolves.toBeNull()
  })

  it('probes bare claude with --version when there is no command override', async () => {
    const probe = vi.fn().mockResolvedValue('1.0.51')
    const host = localHost({ probe })
    await resolveClaudeAskSuppressionFlags(host)
    expect(probe).toHaveBeenCalledWith(['claude', '--version'])
  })

  it('fails open and remembers the failure with a retry interval', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const probe = vi.fn().mockRejectedValue(new Error('ENOENT'))
    const host = localHost({ probe })

    await expect(resolveClaudeAskSuppressionFlags(host)).resolves.toBeNull()
    expect(probe).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1_000 + CLAUDE_ASK_SUPPRESSION_GATE_RETRY_INTERVAL_MS - 1)
    await expect(resolveClaudeAskSuppressionFlags(host)).resolves.toBeNull()
    expect(probe).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1_000 + CLAUDE_ASK_SUPPRESSION_GATE_RETRY_INTERVAL_MS)
    await expect(resolveClaudeAskSuppressionFlags(host)).resolves.toBeNull()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('fails open when the probe output does not parse as a version', async () => {
    const probe = vi.fn().mockResolvedValue('not a version')
    const host = localHost({ probe })
    await expect(resolveClaudeAskSuppressionFlags(host)).resolves.toBeNull()
  })

  it('fails open when the probe exits non-zero (rejects)', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('exit code 1'))
    const host = localHost({ probe })
    await expect(resolveClaudeAskSuppressionFlags(host)).resolves.toBeNull()
  })

  it('probes the whole wrapper override command, not just its first token', async () => {
    const probe = vi.fn().mockResolvedValue('1.2.0')
    const host = localHost({ probe, commandOverride: 'npx claude' })
    await resolveClaudeAskSuppressionFlags(host)
    expect(probe).toHaveBeenCalledWith(['npx', 'claude', '--version'])
  })

  it('reports no flags for a below-floor wrapped binary reached through a wrapper override', async () => {
    const probe = vi.fn().mockResolvedValue('0.9.0')
    const host = localHost({ probe, commandOverride: 'npx claude' })
    await expect(resolveClaudeAskSuppressionFlags(host)).resolves.toBeNull()
  })

  it('re-probes a below-floor host after the retry interval and picks up an in-place upgrade', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const probe = vi.fn().mockResolvedValue('1.0.0')
    const host = localHost({ probe })

    await expect(resolveClaudeAskSuppressionFlags(host)).resolves.toBeNull()
    expect(probe).toHaveBeenCalledTimes(1)

    vi.setSystemTime(1_000 + CLAUDE_ASK_SUPPRESSION_GATE_RETRY_INTERVAL_MS - 1)
    await expect(resolveClaudeAskSuppressionFlags(host)).resolves.toBeNull()
    expect(probe).toHaveBeenCalledTimes(1)

    probe.mockResolvedValue('1.2.0')
    vi.setSystemTime(1_000 + CLAUDE_ASK_SUPPRESSION_GATE_RETRY_INTERVAL_MS)
    await expect(resolveClaudeAskSuppressionFlags(host)).resolves.toEqual(expectedFlags)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('never re-probes once a host has cleared the floor, even long past the retry interval', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const probe = vi.fn().mockResolvedValue('1.2.0')
    const host = localHost({ probe })

    await expect(resolveClaudeAskSuppressionFlags(host)).resolves.toEqual(expectedFlags)

    vi.setSystemTime(1_000 + CLAUDE_ASK_SUPPRESSION_GATE_RETRY_INTERVAL_MS * 10)
    await expect(resolveClaudeAskSuppressionFlags(host)).resolves.toEqual(expectedFlags)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('caches the verdict so a second call on the same host does not re-probe', async () => {
    const probe = vi.fn().mockResolvedValue('1.2.0')
    const host = localHost({ probe })
    await resolveClaudeAskSuppressionFlags(host)
    await resolveClaudeAskSuppressionFlags(host)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('isolates verdicts between the native host and a WSL distro', async () => {
    const nativeProbe = vi.fn().mockResolvedValue('1.2.0')
    const wslProbe = vi.fn().mockResolvedValue('1.0.0')
    const nativeHost = localHost({ probe: nativeProbe })
    const wslHost = localHost({ probe: wslProbe, wslDistro: 'Ubuntu' })

    await expect(resolveClaudeAskSuppressionFlags(nativeHost)).resolves.toEqual(expectedFlags)
    await expect(resolveClaudeAskSuppressionFlags(wslHost)).resolves.toBeNull()
    expect(nativeProbe).toHaveBeenCalledTimes(1)
    expect(wslProbe).toHaveBeenCalledTimes(1)
  })

  it('isolates verdicts between two different WSL distros', async () => {
    const ubuntuProbe = vi.fn().mockResolvedValue('1.2.0')
    const debianProbe = vi.fn().mockResolvedValue('1.0.0')
    const ubuntuHost = localHost({ probe: ubuntuProbe, wslDistro: 'Ubuntu' })
    const debianHost = localHost({ probe: debianProbe, wslDistro: 'Debian' })

    await expect(resolveClaudeAskSuppressionFlags(ubuntuHost)).resolves.toEqual(expectedFlags)
    await expect(resolveClaudeAskSuppressionFlags(debianHost)).resolves.toBeNull()
  })

  it('isolates verdicts between two different SSH providers', async () => {
    const providerA = {}
    const providerB = {}
    const probeA = vi.fn().mockResolvedValue('1.2.0')
    const probeB = vi.fn().mockResolvedValue('1.0.0')
    const hostA: AskGateHostKey = {
      kind: 'ssh',
      sshProvider: providerA,
      shell: 'posix',
      probe: probeA
    }
    const hostB: AskGateHostKey = {
      kind: 'ssh',
      sshProvider: providerB,
      shell: 'posix',
      probe: probeB
    }

    await expect(resolveClaudeAskSuppressionFlags(hostA)).resolves.toEqual(expectedFlags)
    await expect(resolveClaudeAskSuppressionFlags(hostB)).resolves.toBeNull()
    expect(probeA).toHaveBeenCalledTimes(1)
    expect(probeB).toHaveBeenCalledTimes(1)
  })

  it('does not leak an SSH provider verdict into a local host verdict', async () => {
    const sshProbe = vi.fn().mockResolvedValue('1.2.0')
    const localProbe = vi.fn().mockResolvedValue('1.0.0')
    const sshHost: AskGateHostKey = {
      kind: 'ssh',
      sshProvider: {},
      shell: 'posix',
      probe: sshProbe
    }
    const nativeHost = localHost({ probe: localProbe })

    await expect(resolveClaudeAskSuppressionFlags(sshHost)).resolves.toEqual(expectedFlags)
    await expect(resolveClaudeAskSuppressionFlags(nativeHost)).resolves.toBeNull()
  })
})

describe('peekClaudeAskSuppressionFlags', () => {
  it('reports pending and starts the probe for a host it has never decided', async () => {
    const probe = vi.fn().mockResolvedValue('1.2.0')
    const host = localHost({ probe })

    expect(peekClaudeAskSuppressionFlags(host)).toBe('pending')

    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    expect(peekClaudeAskSuppressionFlags(host)).toEqual(expectedFlags)
  })

  it('answers a decided host without probing again', async () => {
    const probe = vi.fn().mockResolvedValue('1.2.0')
    const host = localHost({ probe })
    await resolveClaudeAskSuppressionFlags(host)

    expect(peekClaudeAskSuppressionFlags(host)).toEqual(expectedFlags)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('reports null, not pending, once a probe has concluded below the floor', async () => {
    const host = localHost({ probe: vi.fn().mockResolvedValue('1.0.50') })
    await resolveClaudeAskSuppressionFlags(host)

    expect(peekClaudeAskSuppressionFlags(host)).toBeNull()
  })

  it('keeps answering null across a lapsed retry cooldown while it re-probes', async () => {
    const probe = vi.fn().mockResolvedValue('1.0.50')
    const host = localHost({ probe })
    await resolveClaudeAskSuppressionFlags(host)

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + CLAUDE_ASK_SUPPRESSION_GATE_RETRY_INTERVAL_MS + 1)
    // The cooldown has lapsed, so this both re-probes and must still report the last
    // concluded answer rather than reverting to 'pending'.
    expect(peekClaudeAskSuppressionFlags(host)).toBeNull()
    vi.useRealTimers()

    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
  })

  it('does not re-probe a failed host while its retry cooldown is live', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('ENOENT'))
    const host = localHost({ probe })
    await resolveClaudeAskSuppressionFlags(host)

    expect(peekClaudeAskSuppressionFlags(host)).toBeNull()
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
