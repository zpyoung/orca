import { describe, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { resolveForkTranscriptHost, type ForkTranscriptHost } from './session-transcript-host'

const remoteHome = '/home/ada'
const bucketDir = `${remoteHome}/.claude/projects/-workspace-repo`

function hostInfo(relayPlatform: 'linux-x64' | 'win32-x64' = 'linux-x64') {
  return {
    targetId: 'dev-box',
    executionHostId: 'ssh:dev-box' as const,
    remoteHome: relayPlatform === 'win32-x64' ? 'C:/Users/ada' : remoteHome,
    hostPlatform: getRemoteHostPlatform(relayPlatform)
  }
}

function provider(overrides: Record<string, unknown> = {}) {
  return {
    readDir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockResolvedValue({ type: 'file', size: 1, mtime: 10, mtimeMs: 10 }),
    ...overrides
  }
}

async function sshHost(overrides: Record<string, unknown> = {}): Promise<ForkTranscriptHost> {
  const resolution = await resolveForkTranscriptHost('claude', 'dev-box', {
    sshHostInfo: () => hostInfo(),
    sshProvider: () => provider() as never,
    ...overrides
  })
  if ('failure' in resolution) {
    throw new Error(`expected a host, got ${resolution.failure}`)
  }
  return resolution.host
}

describe('resolveForkTranscriptHost over SSH', () => {
  it('roots the agent under the remote home, not the local one', async () => {
    const host = await sshHost()
    expect(host.roots).toEqual([`${remoteHome}/.claude/projects`])
  })

  it('authorizes a transcript inside the remote agent root', async () => {
    const host = await sshHost()
    expect(host.authorize(`${bucketDir}/session-1.jsonl`)).toBeNull()
  })

  it('refuses a remote path outside every agent root', async () => {
    const host = await sshHost()
    expect(host.authorize('/etc/secrets.jsonl')).toBe('path-outside-known-roots')
  })

  // No remote `resolve()` exists to collapse these, so they are rejected outright.
  it('refuses remote traversal out of the agent root', async () => {
    const host = await sshHost()
    expect(host.authorize(`${bucketDir}/../../../../etc/secrets.jsonl`)).toBe(
      'path-outside-known-roots'
    )
  })

  it('refuses a remote file the vault scanner would never surface', async () => {
    const host = await sshHost()
    expect(host.authorize(`${bucketDir}/notes.md`)).toBe('undiscoverable-path')
    expect(host.authorize(`${bucketDir}/session-1/subagents/task-1.jsonl`)).toBe(
      'undiscoverable-path'
    )
  })

  it('reads directories and stats files through the SSH provider', async () => {
    const remote = provider({
      readDir: vi.fn().mockResolvedValue([{ name: 'session-1.jsonl' }]),
      stat: vi.fn().mockResolvedValue({ type: 'file', size: 1, mtime: 7, mtimeMs: 7000 })
    })
    const host = await sshHost({ sshProvider: () => remote as never })
    await expect(host.readDirectory(bucketDir)).resolves.toEqual(['session-1.jsonl'])
    await expect(host.statFile(`${bucketDir}/session-1.jsonl`)).resolves.toEqual({
      isFile: true,
      modifiedAt: 7000
    })
    expect(remote.readDir).toHaveBeenCalledWith(bucketDir)
  })

  it('falls back to mtime when the remote host reports no mtimeMs', async () => {
    const remote = provider({
      stat: vi.fn().mockResolvedValue({ type: 'directory', size: 0, mtime: 4200 })
    })
    const host = await sshHost({ sshProvider: () => remote as never })
    await expect(host.statFile(bucketDir)).resolves.toEqual({ isFile: false, modifiedAt: 4200 })
  })

  it('joins remote paths in the host’s flavor, not the client’s', async () => {
    const host = await sshHost()
    expect(host.joinPath(`${remoteHome}/.claude/projects`, '-workspace-repo')).toBe(bucketDir)
  })

  it('compares Windows remote paths case-insensitively', async () => {
    const resolution = await resolveForkTranscriptHost('claude', 'dev-box', {
      sshHostInfo: () => hostInfo('win32-x64'),
      sshProvider: () => provider() as never
    })
    if ('failure' in resolution) {
      throw new Error(resolution.failure)
    }
    expect(resolution.host.authorize('c:/users/ada/.claude/projects/bucket/s.jsonl')).toBeNull()
  })

  it('reports a dropped connection as host-unavailable', async () => {
    await expect(
      resolveForkTranscriptHost('claude', 'dev-box', {
        sshHostInfo: () => hostInfo(),
        sshProvider: () => {
          throw new Error('Remote connection dropped.')
        }
      })
    ).resolves.toEqual({ failure: 'host-unavailable' })
  })

  it('reports an agent the remote scanner has no source for as unsupported', async () => {
    await expect(
      resolveForkTranscriptHost('opencode', 'dev-box', {
        sshHostInfo: () => hostInfo(),
        sshProvider: () => provider() as never
      })
    ).resolves.toEqual({ failure: 'unsupported-agent' })
  })

  // The remote host has no session-id index, so the probe substitutes sibling
  // lookups rather than paying a whole-root walk over the wire.
  it('declines the session-id search on a remote host', async () => {
    const host = await sshHost()
    expect(host.supportsSessionIdSearch).toBe(false)
  })
})
