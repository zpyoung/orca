import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FORK_SESSION_HANDOFF_TRANSCRIPT_CHANNEL,
  registerForkSessionHandoffTranscriptProbe
} from './session-transcript-probe-ipc'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/user-data') },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

const resolveTranscript = vi.fn()

function invoke(value: unknown): unknown {
  const handler = handlers.get(FORK_SESSION_HANDOFF_TRANSCRIPT_CHANNEL)
  if (!handler) {
    throw new Error('transcript probe channel was not registered')
  }
  return handler({}, value)
}

describe('registerForkSessionHandoffTranscriptProbe', () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
    registerForkSessionHandoffTranscriptProbe(resolveTranscript)
  })

  it('passes a validated request to the resolver', async () => {
    resolveTranscript.mockResolvedValue({ outcome: 'found', transcriptPath: '/t/session.jsonl' })

    await expect(
      invoke({ agent: 'claude', sessionId: ' session-1 ', transcriptPath: '/t/session.jsonl' })
    ).resolves.toEqual({ outcome: 'found', transcriptPath: '/t/session.jsonl' })
    expect(resolveTranscript).toHaveBeenCalledWith({
      agent: 'claude',
      sessionId: 'session-1',
      transcriptPath: '/t/session.jsonl',
      paneKey: null,
      workspacePath: null,
      connectionId: null
    })
  })

  it('carries the SSH connection through to the resolver', async () => {
    resolveTranscript.mockResolvedValue({ outcome: 'missing' })
    await invoke({
      agent: 'claude',
      sessionId: 'session-1',
      transcriptPath: '/t/session.jsonl',
      connectionId: ' dev-box '
    })
    expect(resolveTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'dev-box' })
    )
  })

  it.each([
    ['a non-object', 'nope'],
    ['a request with no agent', { sessionId: 'session-1', transcriptPath: '/t/session.jsonl' }],
    ['a request with neither a path nor an id', { agent: 'claude' }],
    ['a path carrying control characters', { agent: 'claude', transcriptPath: '/t/a\u0007b.jsonl' }]
  ])('rejects %s without reaching the resolver', async (_label, value) => {
    await expect(invoke(value)).resolves.toEqual({
      outcome: 'unverifiable',
      reason: 'invalid-request'
    })
    expect(resolveTranscript).not.toHaveBeenCalled()
  })
})
