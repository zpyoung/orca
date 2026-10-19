import { describe, expect, it } from 'vitest'
import { resolveForkTranscriptHost } from './session-transcript-host'

describe('resolveForkTranscriptHost', () => {
  it('has no readable disk for a session on an SSH target', async () => {
    await expect(resolveForkTranscriptHost('claude', 'dev-box')).resolves.toEqual({
      failure: 'host-unavailable'
    })
  })

  it('refuses a transcript path outside the agent root', async () => {
    const resolution = await resolveForkTranscriptHost('claude', null, {
      wslHomeDirs: async () => [],
      rootOptions: { claudeProjectsDir: '/home/ada/.claude/projects' }
    })
    if ('failure' in resolution) {
      throw new Error(`expected a host, got ${resolution.failure}`)
    }
    expect(resolution.host.authorize('/etc/passwd')).toBe('path-outside-known-roots')
  })
})
