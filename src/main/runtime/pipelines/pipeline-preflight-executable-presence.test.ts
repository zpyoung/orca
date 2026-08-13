import { beforeEach, describe, expect, it, vi } from 'vitest'

const isCommandOnPathMock = vi.fn()
const detectCommandsInInstallDirsMock = vi.fn()
const detectWslCommandsOnPathMock = vi.fn()
const getActiveMultiplexerMock = vi.fn()

vi.mock('../../ipc/preflight-command-exec', () => ({
  isCommandOnPath: isCommandOnPathMock
}))
vi.mock('../../ipc/local-agent-install-dir-detection', () => ({
  detectCommandsInInstallDirs: detectCommandsInInstallDirsMock
}))
vi.mock('../../ipc/preflight-wsl-agent-detection', () => ({
  detectWslCommandsOnPath: detectWslCommandsOnPathMock
}))
vi.mock('../../ipc/ssh', () => ({
  getActiveMultiplexer: getActiveMultiplexerMock
}))

const { probeAgentPresence } = await import('./pipeline-preflight-executable-presence')

const claudeCommands = [{ id: 'claude' as const, cmd: 'claude' }]

describe('probeAgentPresence', () => {
  beforeEach(() => {
    isCommandOnPathMock.mockReset().mockResolvedValue(false)
    detectCommandsInInstallDirsMock.mockReset().mockReturnValue(new Set())
    detectWslCommandsOnPathMock.mockReset().mockResolvedValue(new Set())
    getActiveMultiplexerMock.mockReset()
  })

  it('reports presence when the native command resolves on PATH', async () => {
    isCommandOnPathMock.mockResolvedValue(true)
    await expect(
      probeAgentPresence({ agent: 'claude', commands: claudeCommands, host: {} })
    ).resolves.toEqual({ ok: true })
  })

  it('falls back to install-dir detection for a command missed on PATH', async () => {
    isCommandOnPathMock.mockResolvedValue(false)
    detectCommandsInInstallDirsMock.mockReturnValue(new Set(['claude']))
    await expect(
      probeAgentPresence({ agent: 'claude', commands: claudeCommands, host: {} })
    ).resolves.toEqual({ ok: true })
  })

  it('reports not-found (not transport) when the native command resolves nowhere', async () => {
    await expect(
      probeAgentPresence({ agent: 'claude', commands: claudeCommands, host: {} })
    ).resolves.toEqual({ ok: false, transport: false })
  })

  it('probes WSL detection for a WSL host', async () => {
    detectWslCommandsOnPathMock.mockResolvedValue(new Set(['claude']))
    await expect(
      probeAgentPresence({
        agent: 'claude',
        commands: claudeCommands,
        host: { wslDistro: 'Ubuntu' }
      })
    ).resolves.toEqual({ ok: true })
    expect(detectWslCommandsOnPathMock).toHaveBeenCalledWith(
      { distro: 'Ubuntu' },
      expect.arrayContaining(['claude'])
    )
  })

  it('reports not-found for a WSL host missing the command', async () => {
    await expect(
      probeAgentPresence({
        agent: 'claude',
        commands: claudeCommands,
        host: { wslDistro: 'Ubuntu' }
      })
    ).resolves.toEqual({ ok: false, transport: false })
  })

  it('probes the relay for an SSH host, sending the client-supplied command list', async () => {
    const request = vi.fn().mockResolvedValue({ agents: ['claude'] })
    getActiveMultiplexerMock.mockReturnValue({ isDisposed: () => false, request })
    await expect(
      probeAgentPresence({
        agent: 'claude',
        commands: claudeCommands,
        host: { connectionId: 'ssh-1' }
      })
    ).resolves.toEqual({ ok: true })
    expect(request).toHaveBeenCalledWith('preflight.detectAgents', { commands: claudeCommands })
  })

  it('reports not-found when the relay does not detect the agent', async () => {
    const request = vi.fn().mockResolvedValue({ agents: [] })
    getActiveMultiplexerMock.mockReturnValue({ isDisposed: () => false, request })
    await expect(
      probeAgentPresence({
        agent: 'claude',
        commands: claudeCommands,
        host: { connectionId: 'ssh-1' }
      })
    ).resolves.toEqual({ ok: false, transport: false })
  })

  it('reports a transport failure when no SSH connection is active', async () => {
    getActiveMultiplexerMock.mockReturnValue(undefined)
    await expect(
      probeAgentPresence({
        agent: 'claude',
        commands: claudeCommands,
        host: { connectionId: 'ssh-1' }
      })
    ).resolves.toEqual({ ok: false, transport: true })
  })

  it('reports a transport failure when the SSH connection is disposed', async () => {
    const request = vi.fn()
    getActiveMultiplexerMock.mockReturnValue({ isDisposed: () => true, request })
    await expect(
      probeAgentPresence({
        agent: 'claude',
        commands: claudeCommands,
        host: { connectionId: 'ssh-1' }
      })
    ).resolves.toEqual({ ok: false, transport: true })
    expect(request).not.toHaveBeenCalled()
  })

  it('reports a transport failure when the relay request throws', async () => {
    const request = vi.fn().mockRejectedValue(new Error('timed out'))
    getActiveMultiplexerMock.mockReturnValue({ isDisposed: () => false, request })
    await expect(
      probeAgentPresence({
        agent: 'claude',
        commands: claudeCommands,
        host: { connectionId: 'ssh-1' }
      })
    ).resolves.toEqual({ ok: false, transport: true })
  })
})
