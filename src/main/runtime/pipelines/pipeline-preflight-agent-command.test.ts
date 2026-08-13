import { describe, expect, it } from 'vitest'
import { resolveEffectiveLaunchProbe } from './pipeline-preflight-agent-command'

describe('resolveEffectiveLaunchProbe', () => {
  it('derives the probe from the catalog detection commands when no override is set', () => {
    const probe = resolveEffectiveLaunchProbe('claude', {})
    expect(probe).not.toBeNull()
    expect(probe?.commands.every((command) => command.id === 'claude')).toBe(true)
    expect(probe?.commands.some((command) => command.cmd === 'claude')).toBe(true)
    expect(probe?.primaryCommand).toBe('claude')
  })

  it('derives the probe from the override command, ignoring the catalog default', () => {
    const probe = resolveEffectiveLaunchProbe('claude', { claude: '/opt/custom/claude-cli --flag' })
    expect(probe).toEqual({
      commands: [{ id: 'claude', cmd: '/opt/custom/claude-cli' }],
      primaryCommand: '/opt/custom/claude-cli'
    })
  })

  it('extracts a quoted override executable token', () => {
    const probe = resolveEffectiveLaunchProbe('claude', {
      claude: `"/opt/custom dir/claude-cli" --flag`
    })
    expect(probe?.primaryCommand).toBe('/opt/custom dir/claude-cli')
  })

  it('returns null when the override cannot be parsed into an executable token', () => {
    const probe = resolveEffectiveLaunchProbe('claude', { claude: '   ' })
    expect(probe).toBeNull()
  })
})
