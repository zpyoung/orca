/* Core IPtyProvider surface of DaemonPtyAdapter: spawn, io, sizing, teardown. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonServer } from './daemon-server'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  waitFor
} from './daemon-pty-adapter-test-harness'
import type * as DaemonHealthModule from './daemon-health'

const {
  getMacDaemonSystemResolverHealthMock,
  getMacDaemonTccAttributionHealthMock,
  isDaemonStaleForCurrentBundleMock
} = vi.hoisted(() => ({
  getMacDaemonSystemResolverHealthMock: vi.fn(
    async (): Promise<'unknown' | 'unhealthy'> => 'unknown'
  ),
  getMacDaemonTccAttributionHealthMock: vi.fn(
    async (): Promise<'intact' | 'severed' | 'unknown'> => 'unknown'
  ),
  isDaemonStaleForCurrentBundleMock: vi.fn(async () => false)
}))

const itOnPosix = process.platform === 'win32' ? it.skip : it

vi.mock('./daemon-health', async (importOriginal) => {
  const actual = await importOriginal<typeof DaemonHealthModule>()
  return {
    ...actual,
    getMacDaemonSystemResolverHealth: getMacDaemonSystemResolverHealthMock,
    getMacDaemonTccAttributionHealth: getMacDaemonTccAttributionHealthMock,
    isDaemonStaleForCurrentBundle: isDaemonStaleForCurrentBundleMock
  }
})

describe('DaemonPtyAdapter (IPtyProvider)', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let lastSubprocess: ReturnType<typeof createMockSubprocess>
  let lastSpawnOpts: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    command?: string
  } | null
  let daemonLogEvents: string[]

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness((opts) => {
      lastSpawnOpts = opts
      lastSubprocess = createMockSubprocess()
      return lastSubprocess
    })
    dir = harness.dir
    socketPath = harness.socketPath
    tokenPath = harness.tokenPath
    server = harness.server
    adapter = harness.adapter
    daemonLogEvents = harness.daemonLogEvents
    lastSpawnOpts = null
    getMacDaemonSystemResolverHealthMock.mockReset()
    getMacDaemonSystemResolverHealthMock.mockResolvedValue('unknown')
    getMacDaemonTccAttributionHealthMock.mockReset()
    getMacDaemonTccAttributionHealthMock.mockResolvedValue('unknown')
    isDaemonStaleForCurrentBundleMock.mockReset()
    isDaemonStaleForCurrentBundleMock.mockResolvedValue(false)
  })

  it('reports whether its daemon protocol can participate in agent claims', () => {
    const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 23 })

    expect(adapter.supportsAgentSessionClaims()).toBe(true)
    expect(legacy.supportsAgentSessionClaims()).toBe(false)
    expect(adapter.supportsAgentSessionCreateOperations()).toBe(true)
    expect(legacy.supportsAgentSessionCreateOperations()).toBe(false)
    legacy.dispose()
  })

  afterEach(async () => {
    adapter?.dispose()
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('spawn', () => {
    it('returns a result with an id', async () => {
      const result = await adapter.spawn({ cols: 80, rows: 24 })
      expect(result.id).toBeDefined()
      expect(typeof result.id).toBe('string')
      expect(result.providerSequence).toEqual({ value: 0, generation: 'reset' })
    })

    it('carries classified startup spans from the daemon source to the adapter', async () => {
      const onData = vi.fn()
      adapter.onData(onData)
      const { id } = await adapter.spawn({
        cols: 80,
        rows: 24,
        startupIngress: {
          colors: { foreground: '#2e3434', background: '#ffffff' },
          deadlineMs: 5_000
        }
      })
      const query = '\x1b]10;?\x07'
      lastSubprocess._simulateData(query)
      lastSubprocess._simulateData('prompt')

      await waitFor(() => onData.mock.calls.length >= 2)

      expect(lastSubprocess.write).toHaveBeenCalledWith('\x1b]10;rgb:2e2e/3434/3434\x1b\\')
      expect(onData).toHaveBeenCalledWith({
        id,
        data: '',
        sequenceChars: query.length,
        seq: query.length,
        transformed: true
      })
      expect(onData).toHaveBeenCalledWith({ id, data: 'prompt' })
      await expect(adapter.getBufferSnapshot(id)).resolves.toMatchObject({
        data: expect.not.stringContaining(']10;rgb')
      })
    })

    it('omits startup intent and close control for the preserved v23 protocol', async () => {
      const ensureConnectedSpy = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const requestSpy = vi.spyOn(DaemonClient.prototype, 'request').mockResolvedValue({
        isNew: true,
        pid: null,
        shellState: 'unsupported',
        snapshot: null
      } as never)
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 23 })
      try {
        await legacy.spawn({
          sessionId: 'legacy-session',
          cols: 80,
          rows: 24,
          startupIngress: {
            colors: { foreground: '#2e3434', background: '#ffffff' },
            deadlineMs: 5_000
          }
        })
        const createPayload = requestSpy.mock.calls.find(([type]) => type === 'createOrAttach')?.[1]
        expect(createPayload).not.toHaveProperty('startupIngress')
        await expect(legacy.closeStartupQueryAuthority('legacy-session')).resolves.toBe(0)
        expect(requestSpy).not.toHaveBeenCalledWith('closeStartupQueryAuthority', expect.anything())
      } finally {
        legacy.dispose()
        requestSpy.mockRestore()
        ensureConnectedSpy.mockRestore()
      }
    })

    it('does not republish adapter state when stream exit beats the create reply', async () => {
      const sessionId = 'exit-before-create-reply'
      const exits: { id: string; incarnationId?: string }[] = []
      adapter.onExit((payload) => exits.push(payload))
      const client = (
        adapter as unknown as {
          client: { request: (type: string, payload?: unknown) => Promise<unknown> }
        }
      ).client
      const originalRequest = client.request.bind(client)
      vi.spyOn(client, 'request').mockImplementation(async (type: string, payload?: unknown) => {
        const response = await originalRequest(type, payload)
        if (type === 'createOrAttach') {
          const exitCount = exits.length
          lastSubprocess._simulateExit(0)
          await waitFor(() => exits.length === exitCount + 1)
        }
        return response
      })

      await adapter.spawn({ cols: 80, rows: 24, sessionId })
      await adapter.spawn({ cols: 80, rows: 24, sessionId })

      expect(exits).toHaveLength(2)
      expect(exits[0]?.incarnationId).toBeDefined()
      expect(exits[1]?.incarnationId).toBeDefined()
      expect(exits[1]?.incarnationId).not.toBe(exits[0]?.incarnationId)
      const internals = adapter as unknown as {
        activeSessionIds: Set<string>
        sessionIncarnations: Map<string, string>
        pendingSpawnOperationsBySessionId: Map<string, unknown>
      }
      expect(internals.activeSessionIds.has(sessionId)).toBe(false)
      expect(internals.sessionIncarnations.has(sessionId)).toBe(false)
      expect(internals.pendingSpawnOperationsBySessionId.has(sessionId)).toBe(false)
    })

    it('does not republish an adopted canonical id when its exit beats the reply', async () => {
      const claim = {
        digestVersion: 1 as const,
        keyId: 'key',
        identityDigest: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        worktreeScopeDigest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        agent: 'codex' as const
      }
      const surface = {
        worktreeId: 'worktree',
        tabId: 'tab',
        leafId: '11111111-1111-4111-8111-111111111111',
        terminalHandle: 'term_claimed'
      }
      const canonicalId = 'canonical-claimed-session'
      const first = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: canonicalId,
        agentSessionEnsure: { claim, surface }
      })
      expect(first.agentSessionEnsure?.disposition).toBe('created')

      const exits: { id: string; incarnationId?: string }[] = []
      adapter.onExit((payload) => exits.push(payload))
      const client = (
        adapter as unknown as {
          client: { request: (type: string, payload?: unknown) => Promise<unknown> }
        }
      ).client
      const originalRequest = client.request.bind(client)
      vi.spyOn(client, 'request').mockImplementation(async (type: string, payload?: unknown) => {
        const response = await originalRequest(type, payload)
        if (type === 'createOrAttach') {
          const exitCount = exits.length
          lastSubprocess._simulateExit(0)
          await waitFor(() => exits.length === exitCount + 1)
        }
        return response
      })

      const adopted = await adapter.spawn({
        cols: 80,
        rows: 24,
        sessionId: 'different-requested-session',
        agentSessionEnsure: {
          claim,
          surface: { ...surface, terminalHandle: 'term_retry' }
        }
      })

      expect(adopted.id).toBe(canonicalId)
      expect(adopted.agentSessionEnsure?.disposition).toBe('adopted')
      expect(adapter.didExitBeforeSpawnReply(adopted)).toBe(true)
      const internals = adapter as unknown as {
        activeSessionIds: Set<string>
        sessionIncarnations: Map<string, string>
        pendingSpawnOperationsBySessionId: Map<string, unknown>
        pendingClaimSpawnOperations: Set<unknown>
      }
      expect(internals.activeSessionIds.has(canonicalId)).toBe(false)
      expect(internals.sessionIncarnations.has(canonicalId)).toBe(false)
      expect(internals.pendingSpawnOperationsBySessionId.has('different-requested-session')).toBe(
        false
      )
      expect(internals.pendingClaimSpawnOperations.size).toBe(0)
    })

    it('does not dispatch createOrAttach when cancellation wins during preflight', async () => {
      let finishPreflight: (() => void) | undefined
      const preflight = new Promise<void>((resolve) => {
        finishPreflight = resolve
      })
      const internals = adapter as unknown as {
        ensureConnected(): Promise<void>
        client: { request: (...args: unknown[]) => Promise<unknown> }
      }
      const ensureConnected = vi
        .spyOn(internals, 'ensureConnected')
        .mockImplementation(() => preflight)
      const request = vi.spyOn(internals.client, 'request')
      const abort = new AbortController()

      const spawning = adapter.spawn({ cols: 80, rows: 24, signal: abort.signal })
      await waitFor(() => ensureConnected.mock.calls.length === 1)
      abort.abort()
      finishPreflight?.()

      await expect(spawning).rejects.toThrow('client_disconnected')
      expect(request).not.toHaveBeenCalledWith('createOrAttach', expect.anything())
    })

    it('uses worktreeId as session prefix when provided', async () => {
      const result = await adapter.spawn({ cols: 80, rows: 24, worktreeId: 'wt-1' })
      expect(result.id).toContain('wt-1')
    })

    it('keeps a reattached native UNC session native despite a conflicting WSL preference', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      try {
        const sessionId = 'native-conflicting-wsl-attach'
        const created = await adapter.spawn({
          cols: 80,
          rows: 24,
          sessionId,
          cwd: '\\\\server\\share\\repo',
          shellOverride: 'powershell.exe'
        })
        const attached = await adapter.spawn({
          cols: 80,
          rows: 24,
          sessionId,
          cwd: 'C:\\repo',
          shellOverride: 'wsl.exe',
          terminalWindowsWslDistro: 'Ubuntu'
        })

        expect(created.wslDistro).toBeNull()
        expect(attached.wslDistro).toBeNull()
        expect(attached.isReattach).toBe(true)
        expect(lastSpawnOpts?.cwd).toBe('\\\\server\\share\\repo')
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }
    })

    itOnPosix('keeps plain Codex startup on the short daemon shell-ready timeout', async () => {
      await adapter.spawn({
        cols: 80,
        rows: 24,
        command: 'codex',
        env: { SHELL: '/bin/zsh' }
      })

      await waitFor(() => vi.mocked(lastSubprocess.write).mock.calls.length > 0)
      expect(lastSubprocess.write).toHaveBeenCalledWith('codex\n')
    })

    itOnPosix('waits for shell-ready for delivery-hinted Codex startup', async () => {
      await adapter.spawn({
        cols: 80,
        rows: 24,
        command: "codex 'linked issue context'",
        startupCommandDelivery: 'shell-ready',
        env: { SHELL: '/bin/zsh' }
      })

      await new Promise((resolve) => setTimeout(resolve, 350))
      expect(lastSubprocess.write).not.toHaveBeenCalled()

      lastSubprocess._simulateData('\x1b]777;orca-shell-ready\x07')
      lastSubprocess._simulateData('\r\nuser@host $ ')

      await waitFor(() => vi.mocked(lastSubprocess.write).mock.calls.length > 0)
      expect(lastSubprocess.write).toHaveBeenCalledWith("codex 'linked issue context'\n")
    })
  })

  describe('write', () => {
    it('sends data to the daemon session', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      adapter.write(id, 'ls\n')

      await new Promise((r) => setTimeout(r, 50))
      expect(lastSubprocess.write).toHaveBeenCalledWith('ls\n')
    })
  })

  describe('resize', () => {
    it('resizes the daemon session', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      adapter.resize(id, 120, 40)

      await new Promise((r) => setTimeout(r, 50))
      expect(lastSubprocess.resize).toHaveBeenCalledWith(120, 40)
    })
  })

  describe('producer flow control', () => {
    it('routes pausePty/resumePty notifications to the daemon session subprocess', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })

      adapter.pauseProducer(id)
      await waitFor(() => lastSubprocess.pause.mock.calls.length > 0)

      adapter.resumeProducer(id)
      await waitFor(() => lastSubprocess.resume.mock.calls.length > 0)
    })

    it('sends pause/resume as fire-and-forget notifications on the current protocol', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
      try {
        adapter.pauseProducer(id)
        adapter.resumeProducer(id)
        expect(notifySpy).toHaveBeenCalledWith('pausePty', { sessionId: id })
        expect(notifySpy).toHaveBeenCalledWith('resumePty', { sessionId: id })
      } finally {
        notifySpy.mockRestore()
      }
    })

    it('never sends pause/resume notifications on a legacy protocol version', () => {
      const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 18 })
      try {
        legacy.pauseProducer('legacy-session')
        legacy.resumeProducer('legacy-session')
        expect(notifySpy).not.toHaveBeenCalled()
      } finally {
        legacy.dispose()
        notifySpy.mockRestore()
      }
    })

    it('owes paused sessions a resumePty on the next connect after a socket drop', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      adapter.pauseProducer(id)
      await waitFor(() => lastSubprocess.pause.mock.calls.length > 0)

      // Drop the daemon out from under the adapter: the in-flight pause now has no matching resume.
      await server.shutdown()
      await waitFor(() => !(adapter as unknown as { client: DaemonClient }).client.isConnected())

      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: (opts) => {
          lastSpawnOpts = opts
          lastSubprocess = createMockSubprocess()
          return lastSubprocess
        }
      })
      await server.start()

      const notifySpy = vi.spyOn(DaemonClient.prototype, 'notify')
      try {
        // Any reconnecting operation must flush the owed resume first.
        await adapter.listProcesses()
        expect(notifySpy).toHaveBeenCalledWith('resumePty', { sessionId: id })
      } finally {
        notifySpy.mockRestore()
      }
    })
  })

  describe('getAppliedSize', () => {
    it('reports the spawn dims before any resize', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      expect(await adapter.getAppliedSize(id)).toEqual({ cols: 80, rows: 24 })
    })

    it('reflects the size the daemon actually applied after a resize', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      adapter.resize(id, 120, 40)
      await waitFor(() => vi.mocked(lastSubprocess.resize).mock.calls.length > 0)
      expect(await adapter.getAppliedSize(id)).toEqual({ cols: 120, rows: 40 })
    })

    // Why: a resize after exit is a dropped fire-and-forget notify; getAppliedSize must report the PTY's last real size, not the drop.
    it('does not advance when a resize is dropped after the session exited', async () => {
      const { id } = await adapter.spawn({ cols: 200, rows: 50 })

      // Child exits, then a late narrow resize races in; daemon Session.resize early-returns for an exited session so 80×24 never lands.
      lastSubprocess._simulateExit(0)
      await new Promise((r) => setTimeout(r, 50))

      adapter.resize(id, 80, 24)
      await new Promise((r) => setTimeout(r, 50))

      // The drop must stay visible: never resized to 80 cols, and getAppliedSize never reports 80 (stays wide, or null once reaped).
      expect(lastSubprocess.resize).not.toHaveBeenCalledWith(80, 24)
      const applied = await adapter.getAppliedSize(id)
      expect(applied?.cols).not.toBe(80)
    })
  })

  describe('getBufferSnapshot', () => {
    it('returns the daemon model with its absolute stream sequence', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      lastSubprocess._simulateData('complete hidden output\r\n')

      const snapshot = await adapter.getBufferSnapshot(id, { scrollbackRows: 123 })

      expect(snapshot).toMatchObject({
        data: expect.stringContaining('complete hidden output'),
        cols: 80,
        rows: 24,
        seq: 'complete hidden output\r\n'.length,
        source: 'headless'
      })
    })

    // A proven `0` and an absent field are different facts. Dropping
    // the zero left consumers unable to tell "the app negotiated nothing" from
    // "this source could not say", which is what makes Preview guess wrong.
    it('publishes proven kitty flags including a known zero', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      lastSubprocess._simulateData('plain output\r\n')

      await expect(adapter.getBufferSnapshot(id)).resolves.toMatchObject({
        kittyKeyboardFlags: 0
      })

      lastSubprocess._simulateData('\x1b[>8u')
      await expect(adapter.getBufferSnapshot(id)).resolves.toMatchObject({
        kittyKeyboardFlags: 8
      })
    })

    // The other half of that contract: a daemon that cannot say must leave the
    // key absent, so consumers keep the state unknown instead of reading a `0`.
    it('omits kitty flags when the daemon snapshot has none', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      lastSubprocess._simulateData('plain output\r\n')
      const realRequest = DaemonClient.prototype.request
      const legacyClient = vi
        .spyOn(DaemonClient.prototype, 'request')
        .mockImplementation(async function (this: DaemonClient, type, payload, timeoutMs) {
          const result = await realRequest.call(this, type, payload, timeoutMs)
          if (type !== 'getSnapshot') {
            return result
          }
          const { snapshot } = result as { snapshot: { modes: Record<string, unknown> } }
          const { kittyKeyboardFlags: _omitted, ...modes } = snapshot.modes
          return { snapshot: { ...snapshot, modes } }
        })

      const snapshot = await adapter.getBufferSnapshot(id)
      legacyClient.mockRestore()

      expect(snapshot).not.toBeNull()
      expect(snapshot).not.toHaveProperty('kittyKeyboardFlags')
    })

    it('exposes live state separately from the visible frame', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      lastSubprocess._simulateData('\x1b[?1049h\x1b[?1004h\x1b[?25lframe')

      const snapshot = await adapter.getBufferSnapshot(id)

      expect(snapshot?.frameRestoreAnsi).toContain('\x1b[?1004h')
      expect(snapshot?.frameRestoreAnsi).toContain('\x1b[?25l')
      expect(snapshot?.frameRestoreAnsi).not.toContain('frame')
      expect(snapshot?.data).toContain('frame')
    })
  })

  describe('shutdown', () => {
    it('kills the session', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      await adapter.shutdown(id, { immediate: false })
      expect(lastSubprocess.kill).toHaveBeenCalled()
    })

    it('force-kills immediately when requested', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      await adapter.shutdown(id, { immediate: true })
      expect(lastSubprocess.kill).not.toHaveBeenCalled()
      expect(lastSubprocess.forceKill).toHaveBeenCalled()
    })

    // Why: shutdown can be the first lazy-client op after restart; connect before killing or a healthy session is orphaned (#7742).
    it('kills a live session from a fresh adapter that has not connected yet', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })

      const freshAdapter = new DaemonPtyAdapter({ socketPath, tokenPath })
      try {
        await freshAdapter.shutdown(id, { immediate: true })
      } finally {
        freshAdapter.dispose()
      }
      expect(lastSubprocess.forceKill).toHaveBeenCalled()
      await expect(adapter.listProcesses()).resolves.not.toContainEqual(
        expect.objectContaining({ id })
      )
    })

    it('coalesces the lazy connection when a fresh adapter shuts down concurrent sessions', async () => {
      const ids = await Promise.all(
        ['concurrent-kill-a', 'concurrent-kill-b'].map(async (sessionId) =>
          adapter.spawn({ cols: 80, rows: 24, sessionId }).then((result) => result.id)
        )
      )
      const freshAdapter = new DaemonPtyAdapter({ socketPath, tokenPath })
      daemonLogEvents.length = 0

      try {
        await Promise.all(ids.map((id) => freshAdapter.shutdown(id, { immediate: true })))
      } finally {
        freshAdapter.dispose()
      }

      await expect(adapter.listProcesses()).resolves.toEqual([])
      expect(daemonLogEvents.filter((event) => event === 'client-hello-accepted')).toHaveLength(2)
    })
  })

  describe('sessionsNeedingFullCheckpoint cleanup (leak regression)', () => {
    // Why: cold-restore flags a session for a full checkpoint; exiting before it lands leaked a permanent Set entry for the daemon's life.
    it('clears the pending full-checkpoint flag when a session exits', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const internals = adapter as unknown as { sessionsNeedingFullCheckpoint: Set<string> }
      // Simulate the cold-restore reanchor path having flagged this session.
      internals.sessionsNeedingFullCheckpoint.add(id)
      expect(internals.sessionsNeedingFullCheckpoint.has(id)).toBe(true)

      lastSubprocess._simulateExit(0)
      await new Promise((r) => setTimeout(r, 50))

      expect(internals.sessionsNeedingFullCheckpoint.has(id)).toBe(false)
    })
  })

  describe('sendSignal', () => {
    it('sends signal to the session', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      await adapter.sendSignal(id, 'SIGINT')

      expect(lastSubprocess.signal).toHaveBeenCalledWith('SIGINT')
    })
  })

  describe('getCwd', () => {
    it('returns empty string when no CWD tracked', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const cwd = await adapter.getCwd(id)
      expect(cwd).toBe('')
    })
  })

  describe('getInitialCwd', () => {
    it('returns the cwd passed at spawn time', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24, cwd: '/home/user' })
      const cwd = await adapter.getInitialCwd(id)
      expect(cwd).toBe('/home/user')
    })

    it('returns empty string when no cwd provided', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const cwd = await adapter.getInitialCwd(id)
      expect(cwd).toBe('')
    })
  })

  describe('clearBuffer', () => {
    it('does not throw', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      await expect(adapter.clearBuffer(id)).resolves.toBeUndefined()
    })
  })

  describe('onData', () => {
    it('routes data events from daemon', async () => {
      const dataPayloads: { id: string; data: string }[] = []
      adapter.onData((payload) => dataPayloads.push(payload))

      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      lastSubprocess._simulateData('hello')

      await waitFor(() => dataPayloads.length > 0)
      expect(dataPayloads[0]).toEqual({ id, data: 'hello' })
    })

    it('coalesces burst data events before serializing daemon stream output', async () => {
      const dataPayloads: { id: string; data: string }[] = []
      adapter.onData((payload) => dataPayloads.push(payload))

      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      lastSubprocess._simulateData('a')
      lastSubprocess._simulateData('b')
      lastSubprocess._simulateData('c')

      await waitFor(() => dataPayloads.length > 0)
      expect(dataPayloads).toEqual([{ id, data: 'abc' }])
    })
  })

  describe('onExit', () => {
    it('routes exit events from daemon', async () => {
      const exits: { id: string; code: number }[] = []
      adapter.onExit((payload) => exits.push(payload))

      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      lastSubprocess._simulateExit(42)

      await waitFor(() => exits.length > 0)
      expect(exits[0]).toEqual({ id, code: 42, incarnationId: expect.any(String) })
    })
  })

  describe('spawn with sessionId (reattach)', () => {
    it('returns full snapshot and isReattach when reattaching', async () => {
      const sessionId = 'reattach-test-session'
      const first = await adapter.spawn({ cols: 80, rows: 24, sessionId, launchAgent: 'droid' })
      expect(first.id).toBe(sessionId)
      expect(first.isReattach).toBeUndefined()
      expect(first.launchAgent).toBe('droid')

      // Write data so the headless emulator captures it
      lastSubprocess._simulateData('hello from shell\r\n')
      await new Promise((r) => setTimeout(r, 50))

      // Spawn again with the same sessionId — should reattach
      const second = await adapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(second.id).toBe(sessionId)
      expect(second.isReattach).toBe(true)
      expect(second.launchAgent).toBe('droid')
      expect(second.snapshot).toBeDefined()
      expect(second.snapshot).toContain('hello from shell')
      expect(second.providerSequence).toEqual({
        value: 'hello from shell\r\n'.length,
        generation: 'continued'
      })
    })

    it('includes rehydrateSequences in snapshot when terminal modes are active', async () => {
      const sessionId = 'rehydrate-test'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })

      // Enable bracketed paste mode, then write visible output
      lastSubprocess._simulateData('\x1b[?2004h')
      lastSubprocess._simulateData('prompt$ ')
      await new Promise((r) => setTimeout(r, 50))

      const result = await adapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.isReattach).toBe(true)
      expect(result.snapshot).toContain('\x1b[?2004h')
      expect(result.snapshot).toContain('prompt$')
    })

    it('publishes the alt-frame payload as explicit strings', async () => {
      const sessionId = 'alt-frame-boundary'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })
      lastSubprocess._simulateData('\x1b[?1049h\x1b[HSTATIC-ALT-FRAME')
      await new Promise((r) => setTimeout(r, 50))

      const result = await adapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(result.snapshotPrefixAnsi).toContain('\x1b[?1049h')
      expect(result.snapshotFrameAnsi).toContain('STATIC-ALT-FRAME')
      expect(result.snapshot).toBe([result.snapshotPrefixAnsi, result.snapshotFrameAnsi].join(''))
      expect(result.snapshotFrameRestoreAnsi).not.toContain('STATIC-ALT-FRAME')
    })

    it('returns the preserved sequence from attach-only adoption', async () => {
      const sessionId = 'attach-sequence-handoff'
      await adapter.spawn({ cols: 80, rows: 24, sessionId })
      lastSubprocess._simulateData('preserved output')
      await new Promise((r) => setTimeout(r, 50))

      await expect(adapter.attach(sessionId)).resolves.toEqual({
        providerSequence: {
          value: 'preserved output'.length,
          generation: 'continued'
        }
      })
    })

    it('returns plain result for new sessionId', async () => {
      const result = await adapter.spawn({ cols: 80, rows: 24, sessionId: 'brand-new' })
      expect(result.id).toBe('brand-new')
      expect(result.isReattach).toBeUndefined()
      expect(result.snapshot).toBeUndefined()
      expect(result.providerSequence).toEqual({ value: 0, generation: 'reset' })
    })

    it('forwards attach-only and never creates an absent stable session', async () => {
      const subprocessBeforeAttach = lastSubprocess
      await expect(
        adapter.spawn({
          cols: 80,
          rows: 24,
          sessionId: 'missing-stable-pane-session',
          attachOnly: true
        })
      ).rejects.toThrow('Session not found: missing-stable-pane-session')
      expect(lastSubprocess).toBe(subprocessBeforeAttach)
    })

    it('does not inspect cold history for attach-only ownership checks', async () => {
      const historyDir = join(dir, 'attach-only-history')
      const historyAdapter = new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        historyPath: historyDir
      })
      const reader = (historyAdapter as unknown as { historyReader: HistoryReader }).historyReader
      const probe = vi.spyOn(reader, 'probeRestorableHistory')
      const getAppliedSize = vi.spyOn(historyAdapter, 'getAppliedSize')

      try {
        await expect(
          historyAdapter.spawn({
            cols: 80,
            rows: 24,
            sessionId: 'missing-attach-only-history-session',
            attachOnly: true
          })
        ).rejects.toThrow('Session not found: missing-attach-only-history-session')
        expect(probe).not.toHaveBeenCalled()
        expect(getAppliedSize).not.toHaveBeenCalled()
      } finally {
        historyAdapter.dispose()
      }
    })

    it('reattaches a stable pane through a preserved v30 daemon', async () => {
      const ensureConnected = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const request = vi.spyOn(DaemonClient.prototype, 'request').mockResolvedValue({
        isNew: false,
        snapshot: null,
        pid: 4321,
        shellState: 'unsupported',
        incarnationId: 'legacy-stable-pane-incarnation'
      })
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 30 })
      try {
        await expect(
          legacy.spawn({
            cols: 80,
            rows: 24,
            sessionId: 'legacy-stable-pane-session',
            attachOnly: true,
            command: 'must-not-run'
          })
        ).resolves.toMatchObject({
          id: 'legacy-stable-pane-session',
          incarnationId: 'legacy-stable-pane-incarnation',
          isReattach: true
        })
        expect(request).toHaveBeenCalledWith(
          'createOrAttach',
          expect.objectContaining({
            command: undefined,
            launchAgent: undefined,
            startupCommandDelivery: undefined
          })
        )
        expect(request.mock.calls[0]?.[1]).not.toHaveProperty('attachOnly')
      } finally {
        legacy.dispose()
        request.mockRestore()
        ensureConnected.mockRestore()
      }
    })

    it('retires a replacement created by a raced-out v30 stable pane', async () => {
      const ensureConnected = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const request = vi
        .spyOn(DaemonClient.prototype, 'request')
        .mockResolvedValueOnce({
          isNew: true,
          snapshot: null,
          pid: 4321,
          shellState: 'unsupported',
          incarnationId: 'legacy-replacement-incarnation'
        })
        .mockResolvedValueOnce({})
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 30 })
      try {
        await expect(
          legacy.spawn({
            cols: 80,
            rows: 24,
            sessionId: 'raced-out-legacy-session',
            attachOnly: true,
            command: 'must-not-run'
          })
        ).rejects.toThrow('Session not found: raced-out-legacy-session')
        expect(request).toHaveBeenNthCalledWith(
          1,
          'createOrAttach',
          expect.objectContaining({ command: undefined })
        )
        expect(request).toHaveBeenNthCalledWith(2, 'kill', {
          sessionId: 'raced-out-legacy-session',
          immediate: true
        })
        expect(legacy.getActiveSessionIds()).toEqual([])
      } finally {
        legacy.dispose()
        request.mockRestore()
        ensureConnected.mockRestore()
      }
    })
  })

  describe('attach', () => {
    it('reattaches to existing session and receives events', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })

      // Create a second adapter simulating app restart
      const adapter2 = new DaemonPtyAdapter({ socketPath, tokenPath })
      const dataPayloads: { id: string; data: string }[] = []
      adapter2.onData((payload) => dataPayloads.push(payload))

      await adapter2.attach(id)

      lastSubprocess._simulateData('after-reattach')
      await waitFor(() => dataPayloads.length > 0)
      expect(dataPayloads[0]).toEqual({ id, data: 'after-reattach' })

      adapter2.dispose()
    })

    it('preserves the live session dimensions instead of forcing 80×24', async () => {
      const { id } = await adapter.spawn({ cols: 137, rows: 41 })

      const adapter2 = new DaemonPtyAdapter({ socketPath, tokenPath })
      await adapter2.attach(id)

      // The running TUI keeps its geometry: no resize, size unchanged.
      expect(lastSubprocess.resize).not.toHaveBeenCalled()
      expect(await adapter2.getAppliedSize(id)).toEqual({ cols: 137, rows: 41 })
      adapter2.dispose()
    })

    it('keeps legacy attach behavior when no output sequence is available', async () => {
      const ensureConnected = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const request = vi
        .spyOn(DaemonClient.prototype, 'request')
        .mockImplementation(async (type: string) =>
          type === 'getSize'
            ? ({ size: { cols: 100, rows: 30 } } as never)
            : ({
                isNew: false,
                snapshot: null,
                pid: 4321,
                shellState: 'unsupported',
                incarnationId: 'legacy-attach-incarnation'
              } as never)
        )
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 30 })
      try {
        await expect(legacy.attach('legacy-session')).resolves.toBeUndefined()
      } finally {
        legacy.dispose()
        request.mockRestore()
        ensureConnected.mockRestore()
      }
    })

    it('refuses to create when the session is absent (attach-only)', async () => {
      const adapter2 = new DaemonPtyAdapter({ socketPath, tokenPath })

      await expect(adapter2.attach('wt-x@@deadbeef')).rejects.toThrow(
        'Session not found: wt-x@@deadbeef'
      )

      // No shell was spawned as a side effect of the refused attach.
      expect(lastSpawnOpts).toBeNull()
      adapter2.dispose()
    })

    it('retires the accidental spawn of a pre-v31 daemon that ignores attachOnly', async () => {
      const ensureConnectedSpy = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const requestSpy = vi
        .spyOn(DaemonClient.prototype, 'request')
        .mockImplementation(async (type: string) =>
          type === 'getSize'
            ? ({ size: { cols: 100, rows: 30 } } as never)
            : type === 'createOrAttach'
              ? ({ isNew: true, pid: 77, shellState: 'unsupported', snapshot: null } as never)
              : ({} as never)
        )
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 30 })
      try {
        await expect(legacy.attach('raced-legacy-session')).rejects.toThrow(
          'Session not found: raced-legacy-session'
        )

        expect(requestSpy).toHaveBeenCalledWith(
          'createOrAttach',
          expect.objectContaining({ cols: 100, rows: 30, attachOnly: true })
        )
        expect(requestSpy).toHaveBeenCalledWith('kill', {
          sessionId: 'raced-legacy-session',
          immediate: true
        })
      } finally {
        legacy.dispose()
        requestSpy.mockRestore()
        ensureConnectedSpy.mockRestore()
      }
    })

    it('surfaces a failed retire of the accidental legacy spawn instead of swallowing it', async () => {
      const ensureConnectedSpy = vi
        .spyOn(DaemonClient.prototype, 'ensureConnected')
        .mockResolvedValue()
      const requestSpy = vi
        .spyOn(DaemonClient.prototype, 'request')
        .mockImplementation(async (type: string) => {
          if (type === 'getSize') {
            return { size: { cols: 100, rows: 30 } } as never
          }
          if (type === 'createOrAttach') {
            return { isNew: true, pid: 77, shellState: 'unsupported', snapshot: null } as never
          }
          throw new Error('kill transport lost')
        })
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const legacy = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: 30 })
      try {
        await expect(legacy.attach('orphaned-legacy-session')).rejects.toThrow(
          'Session not found: orphaned-legacy-session'
        )

        // The orphaned replacement is at least diagnosable.
        expect(warnSpy).toHaveBeenCalledWith(
          '[daemon] attach-only retire of accidental legacy spawn failed',
          expect.objectContaining({ sessionId: 'orphaned-legacy-session' })
        )
      } finally {
        legacy.dispose()
        warnSpy.mockRestore()
        requestSpy.mockRestore()
        ensureConnectedSpy.mockRestore()
      }
    })
  })

  describe('listProcesses', () => {
    // Why: hasPty reads the activeSessionIds cache; an exit missed while the
    // socket was down must not survive an authoritative inventory, or absence
    // proofs (terminal list demotion, send guard) are defeated forever.
    it('drops cached session ids an authoritative inventory omits', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const staleId = 'repo::/repo/stale@@deadbeef'
      ;(adapter as unknown as { activeSessionIds: Set<string> }).activeSessionIds.add(staleId)
      expect(adapter.hasPty(staleId)).toBe(true)

      await adapter.listProcesses()

      expect(adapter.hasPty(staleId)).toBe(false)
      expect(adapter.hasPty(id)).toBe(true)
    })

    it('returns active sessions', async () => {
      await adapter.spawn({
        cols: 80,
        rows: 24,
        cwd: '/repo/owned-before-osc7',
        worktreeId: 'repo::/repo/owned-before-osc7'
      })
      await adapter.spawn({ cols: 80, rows: 24 })

      const procs = await adapter.listProcesses()
      expect(procs).toHaveLength(2)
      expect(procs[0]).toHaveProperty('id')
      expect(procs[0]).toHaveProperty('cwd')
      expect(procs[0]).toHaveProperty('title')
      expect(procs[0].cwd).toBe('/repo/owned-before-osc7')
      expect(procs[0].worktreeId).toBe('repo::/repo/owned-before-osc7')
      expect(adapter.getLastAuditObservation()).toMatchObject({
        state: 'present',
        reason: 'authenticated_inventory',
        inventoryAuthority: 'authoritative'
      })
    })

    it('loads persisted Linux birth identity for audit observations', async () => {
      adapter.dispose()
      await server.shutdown()
      const startedAtMs = 1_700_000_000_000
      const launchNonce = 'launch-with-linux-identity'
      server = new DaemonServer({
        socketPath,
        tokenPath,
        startedAtMs,
        launchNonce,
        log: daemonLog,
        spawnSubprocess: (opts) => {
          lastSpawnOpts = opts
          lastSubprocess = createMockSubprocess()
          return lastSubprocess
        }
      })
      await server.start()
      const pidPath = join(dir, 'daemon.pid')
      writeFileSync(
        pidPath,
        serializeDaemonPidFile({
          pid: process.pid,
          startedAtMs,
          launchNonce,
          linuxStartTicks: '4242',
          bootId: 'boot-a'
        })
      )
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      try {
        adapter = new DaemonPtyAdapter({ socketPath, tokenPath, pidPath })

        await expect(adapter.listProcesses()).resolves.toEqual([])

        expect(adapter.getLastAuditObservation()?.exactIncarnation).toMatchObject({
          linuxStartTicks: '4242',
          bootId: 'boot-a'
        })
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }
    })

    it('reports the daemon session WSL owner', async () => {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      try {
        const spawned = await adapter.spawn({
          cols: 80,
          rows: 24,
          cwd: '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
        })

        const procs = await adapter.listProcesses()

        expect(procs.find((process) => process.id === spawned.id)?.wslDistro).toBe('Ubuntu')
      } finally {
        if (platform) {
          Object.defineProperty(process, 'platform', platform)
        }
      }
    })

    it('retains authenticated identity and reports replacement across a same-endpoint reconnect', async () => {
      await adapter.listProcesses()
      const firstIdentity = adapter.getLastAuthenticatedDaemonIdentity()
      expect(firstIdentity).not.toBeNull()
      const identityChanges: {
        previous: NonNullable<typeof firstIdentity>
        current: NonNullable<typeof firstIdentity>
      }[] = []
      adapter.onDaemonIdentityChanged(() => {
        throw new Error('audit listener failed')
      })
      adapter.onDaemonIdentityChanged((event) => identityChanges.push(event))

      await server.shutdown()
      await waitFor(
        () => !(adapter as unknown as { client: { isConnected(): boolean } }).client.isConnected()
      )
      expect(adapter.getLastAuthenticatedDaemonIdentity()).toEqual(firstIdentity)
      server = new DaemonServer({
        socketPath,
        tokenPath,
        launchNonce: 'replacement-launch',
        startedAtMs: (firstIdentity?.startedAtMs ?? 0) + 10_000,
        log: daemonLog,
        spawnSubprocess: (opts) => {
          lastSpawnOpts = opts
          lastSubprocess = createMockSubprocess()
          return lastSubprocess
        }
      })
      await server.start()

      await expect(adapter.listProcesses()).resolves.toEqual([])

      expect(identityChanges).toEqual([
        {
          previous: firstIdentity,
          current: {
            pid: process.pid,
            startedAtMs: (firstIdentity?.startedAtMs ?? 0) + 10_000,
            launchNonce: 'replacement-launch'
          }
        }
      ])
      expect(adapter.getLastAuthenticatedDaemonIdentity()).toEqual(identityChanges[0]?.current)
    })

    it('isolates audit observation listeners from inventory and later listeners', async () => {
      const laterListener = vi.fn()
      adapter.onAuditEligibilityObservation(() => {
        throw new Error('audit listener failed')
      })
      adapter.onAuditEligibilityObservation(laterListener)

      await expect(adapter.listProcesses()).resolves.toEqual([])

      expect(laterListener).toHaveBeenCalledOnce()
      expect(laterListener).toHaveBeenCalledWith(
        expect.objectContaining({
          state: 'present',
          reason: 'authenticated_inventory'
        })
      )
      expect(adapter.getLastAuditObservation()).toMatchObject({
        state: 'present',
        reason: 'authenticated_inventory'
      })
    })

    it('audits token ENOENT only after an authenticated disconnect', async () => {
      const observations: {
        trigger: string
        state: string
        evidenceSources: readonly string[]
      }[] = []
      adapter.onAuditEligibilityObservation((observation) => observations.push(observation))
      await adapter.listProcesses()

      await server.shutdown()
      await waitFor(
        () => !(adapter as unknown as { client: { isConnected(): boolean } }).client.isConnected()
      )
      await expect(adapter.listProcesses()).rejects.toThrow()
      await waitFor(() =>
        observations.some(
          (observation) => observation.trigger === 'token_missing_after_authenticated_disconnect'
        )
      )

      expect(observations).toContainEqual(
        expect.objectContaining({
          trigger: 'token_missing_after_authenticated_disconnect',
          state: 'unknown',
          evidenceSources: expect.arrayContaining(['token_file'])
        })
      )
    })
  })

  describe('hasChildProcesses / getForegroundProcess', () => {
    it('returns false for shell foreground processes', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      vi.mocked(lastSubprocess.getForegroundProcess).mockReturnValue('bash')
      expect(await adapter.hasChildProcesses(id)).toBe(false)
    })

    it('returns true for non-shell foreground processes', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      vi.mocked(lastSubprocess.getForegroundProcess).mockReturnValue('codex')
      expect(await adapter.hasChildProcesses(id)).toBe(true)
    })

    it('returns the foreground process', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      vi.mocked(lastSubprocess.getForegroundProcess).mockReturnValue('codex')
      expect(await adapter.getForegroundProcess(id)).toBe('codex')
    })
  })

  describe('inspectProcess on pre-inspection daemon protocols', () => {
    type ClientInternals = {
      client: { request: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }
    }

    function createInspectionAdapter(
      protocolVersion: number,
      request: ReturnType<typeof vi.fn>
    ): DaemonPtyAdapter {
      const inspectionAdapter = new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        protocolVersion
      })
      ;(inspectionAdapter as unknown as ClientInternals).client = {
        request,
        disconnect: vi.fn()
      }
      return inspectionAdapter
    }

    it('reports protocol 10 inspection as unavailable without unsupported RPCs', async () => {
      const request = vi.fn()
      const legacy = createInspectionAdapter(GET_FOREGROUND_PROCESS_PROTOCOL_VERSION - 1, request)

      await expect(legacy.inspectProcess('sess-a')).resolves.toEqual({
        foregroundProcess: null,
        hasChildProcesses: true,
        unavailable: true
      })
      await expect(legacy.getForegroundProcess('sess-a')).resolves.toBeNull()
      await expect(legacy.hasChildProcesses('sess-a')).resolves.toBe(true)
      expect(request).not.toHaveBeenCalled()

      legacy.dispose()
    })

    it.each([
      GET_FOREGROUND_PROCESS_PROTOCOL_VERSION,
      COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION - 1
    ])('composes protocol %s inspection from getForegroundProcess', async (protocolVersion) => {
      const request = vi.fn(async () => ({ foregroundProcess: 'codex' }))
      const legacy = createInspectionAdapter(protocolVersion, request)

      expect(await legacy.inspectProcess('sess-a')).toEqual({
        foregroundProcess: 'codex',
        hasChildProcesses: true
      })
      expect(request).toHaveBeenCalledWith('getForegroundProcess', { sessionId: 'sess-a' })
      expect(request).not.toHaveBeenCalledWith('inspectProcess', expect.anything())

      legacy.dispose()
    })

    it('reports an idle shell as having no child processes', async () => {
      const legacy = createInspectionAdapter(
        COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION - 1,
        vi.fn(async () => ({ foregroundProcess: 'bash' }))
      )

      expect(await legacy.inspectProcess('sess-a')).toEqual({
        foregroundProcess: 'bash',
        hasChildProcesses: false
      })

      legacy.dispose()
    })

    it('reports a null foreground as idle, matching what the legacy daemon can report', async () => {
      const legacy = createInspectionAdapter(
        COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION - 1,
        vi.fn(async () => ({ foregroundProcess: null }))
      )

      expect(await legacy.inspectProcess('sess-a')).toEqual({
        foregroundProcess: null,
        hasChildProcesses: false
      })

      legacy.dispose()
    })

    it('rejects rather than reading as idle when the daemon call fails', async () => {
      // Why: getForegroundProcess swallows errors into null; composing through it would turn a dead
      // socket into a false "agent exited" completion, the mirror of the bug this path fixes.
      const legacy = createInspectionAdapter(
        COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION - 1,
        vi.fn(async () => {
          throw new Error('socket_closed')
        })
      )

      await expect(legacy.inspectProcess('sess-a')).rejects.toThrow('socket_closed')

      legacy.dispose()
    })

    it.each([COMPLETION_PROCESS_INSPECTION_PROTOCOL_VERSION, PROTOCOL_VERSION])(
      'delegates protocol %s inspection to inspectProcess',
      async (protocolVersion) => {
        const request = vi.fn(async () => ({ foregroundProcess: 'codex', hasChildProcesses: true }))
        const current = createInspectionAdapter(protocolVersion, request)

        await current.inspectProcess('sess-a')

        expect(request).toHaveBeenCalledWith('inspectProcess', { sessionId: 'sess-a' })

        current.dispose()
      }
    )
  })

  describe('serialize / revive', () => {
    it('serialize returns JSON', async () => {
      const { id } = await adapter.spawn({ cols: 80, rows: 24 })
      const state = await adapter.serialize([id])
      expect(() => JSON.parse(state)).not.toThrow()
    })

    it('revive does not throw', async () => {
      await expect(adapter.revive('{}')).resolves.toBeUndefined()
    })
  })

  describe('getDefaultShell / getProfiles', () => {
    it('returns a shell path', async () => {
      const shell = await adapter.getDefaultShell()
      expect(shell.length).toBeGreaterThan(0)
    })

    it('returns profiles', async () => {
      const profiles = await adapter.getProfiles()
      expect(Array.isArray(profiles)).toBe(true)
    })
  })

  describe('dispose', () => {
    it('disconnects without killing sessions', async () => {
      await adapter.spawn({ cols: 80, rows: 24, worktreeId: 'wt-1' })
      adapter.dispose()

      // Session survives — verify by connecting new adapter
      const adapter2 = new DaemonPtyAdapter({ socketPath, tokenPath })
      const procs = await adapter2.listProcesses()
      expect(procs).toHaveLength(1)
      adapter2.dispose()
    })
  })

  describe('fanoutSyntheticExits / getActiveSessionIds (restart primitives)', () => {
    it('reports every live spawn in getActiveSessionIds', async () => {
      const { id: id1 } = await adapter.spawn({ cols: 80, rows: 24 })
      const { id: id2 } = await adapter.spawn({ cols: 80, rows: 24 })
      const active = adapter.getActiveSessionIds()
      expect(active).toContain(id1)
      expect(active).toContain(id2)
      expect(active).toHaveLength(2)
    })

    it('emits a synthetic exit for every active id with the supplied code', () => {
      const exits: { id: string; code: number }[] = []
      adapter.onExit((payload) => exits.push(payload))

      const ids = ['sess-a', 'sess-b', 'sess-c']
      const internals = adapter as unknown as { activeSessionIds: Set<string> }
      for (const id of ids) {
        internals.activeSessionIds.add(id)
      }

      adapter.fanoutSyntheticExits(-1)

      expect(exits).toHaveLength(3)
      expect(exits.map((e) => e.id).sort()).toEqual([...ids].sort())
      for (const { code } of exits) {
        expect(code).toBe(-1)
      }
    })

    it('clears activeSessionIds after fanout so a second call is a no-op', () => {
      const exits: { id: string; code: number }[] = []
      adapter.onExit((payload) => exits.push(payload))

      const internals = adapter as unknown as { activeSessionIds: Set<string> }
      internals.activeSessionIds.add('sess-a')

      adapter.fanoutSyntheticExits(-1)
      expect(exits).toHaveLength(1)
      expect(adapter.getActiveSessionIds()).toEqual([])

      adapter.fanoutSyntheticExits(-1)
      expect(exits).toHaveLength(1)
    })

    it('propagates to every registered exit listener in order', () => {
      const aExits: { id: string; code: number }[] = []
      const bExits: { id: string; code: number }[] = []
      adapter.onExit((payload) => aExits.push(payload))
      adapter.onExit((payload) => bExits.push(payload))

      const internals = adapter as unknown as { activeSessionIds: Set<string> }
      internals.activeSessionIds.add('sess-a')

      adapter.fanoutSyntheticExits(-1)

      expect(aExits).toEqual([{ id: 'sess-a', code: -1 }])
      expect(bExits).toEqual([{ id: 'sess-a', code: -1 }])
    })
  })
})
