import { afterEach, describe, expect, it } from 'vitest'
import { resolveEffectiveLaunchProbe } from './pipeline-preflight-agent-command'

function withPlatform(platform: NodeJS.Platform, run: () => void): void {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    run()
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
}

describe('resolveEffectiveLaunchProbe', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: process.platform, configurable: true })
  })

  it('derives the probe from the resolved launch command when no override is set', () => {
    const probe = resolveEffectiveLaunchProbe('claude', {}, {})
    expect(probe).toEqual({ commands: [{ id: 'claude', cmd: 'claude' }], primaryCommand: 'claude' })
  })

  it('derives the probe from the override command, ignoring the catalog default', () => {
    const probe = resolveEffectiveLaunchProbe('claude', { claude: '/opt/custom/claude-cli --flag' }, {})
    expect(probe).toEqual({
      commands: [{ id: 'claude', cmd: '/opt/custom/claude-cli' }],
      primaryCommand: '/opt/custom/claude-cli'
    })
  })

  it('extracts a quoted override executable token', () => {
    const probe = resolveEffectiveLaunchProbe(
      'claude',
      { claude: `"/opt/custom dir/claude-cli" --flag` },
      {}
    )
    expect(probe?.primaryCommand).toBe('/opt/custom dir/claude-cli')
  })

  it('returns null when the override cannot be parsed into an executable token', () => {
    const probe = resolveEffectiveLaunchProbe('claude', { claude: '   ' }, {})
    expect(probe).toBeNull()
  })

  it('probes the launch command, not the legacy detection alias, for an agent whose detect and launch names diverge', () => {
    withPlatform('linux', () => {
      const probe = resolveEffectiveLaunchProbe('mistral-vibe', {}, {})
      expect(probe).toEqual({ commands: [{ id: 'mistral-vibe', cmd: 'vibe' }], primaryCommand: 'vibe' })
    })
  })

  it('probes the platform-specific launch command, not the shared detection alias, for orca claude-agent-teams', () => {
    withPlatform('linux', () => {
      const probe = resolveEffectiveLaunchProbe('claude-agent-teams', {}, {})
      expect(probe?.primaryCommand).toBe('orca-ide')
    })
  })

  it('resolves an override with a POSIX-escaped space using the WSL guest shell, not the controller platform', () => {
    withPlatform('win32', () => {
      const probe = resolveEffectiveLaunchProbe(
        'claude',
        { claude: '/opt/my\\ agent/bin --flag' },
        { wslDistro: 'Ubuntu' }
      )
      expect(probe?.primaryCommand).toBe('/opt/my agent/bin')
    })
  })

  it('parses an override with the controller platform when the host is native', () => {
    withPlatform('win32', () => {
      const probe = resolveEffectiveLaunchProbe('claude', { claude: '/opt/my\\ agent/bin --flag' }, {})
      expect(probe?.primaryCommand).toBe('/opt/my\\')
    })
  })
})
