import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

import { RuntimeClientError } from '../runtime-client'
import { ASK_HANDLERS } from './handlers'

const VALID_SPEC_JSON = '{"questions":[{"id":"confirm_deploy","type":"confirm","question":"Deploy now?"}]}'

function ctx(flags: [string, string | boolean][], overrides: { cwd?: string } = {}) {
  return {
    flags: new Map<string, string | boolean>(flags),
    client: { call: callMock },
    cwd: overrides.cwd ?? '/repo',
    json: false
  } as never
}

describe('ask flag and spec validation (client.call never invoked on bad input)', () => {
  beforeEach(() => {
    callMock.mockReset()
  })

  it('rejects a missing --spec', async () => {
    await expect(ASK_HANDLERS.ask(ctx([]))).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON in --spec', async () => {
    await expect(ASK_HANDLERS.ask(ctx([['spec', '{not json']]))).rejects.toThrow(/--spec/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects a spec that fails validateAskSpec, naming the offending field', async () => {
    const badSpec = '{"questions":[{"id":"","type":"confirm","question":"Deploy?"}]}'
    await expect(ASK_HANDLERS.ask(ctx([['spec', badSpec]]))).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('questions[0].id')
    })
    expect(callMock).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', true],
    ['empty', ''],
    ['non-numeric', 'soon'],
    ['zero', '0'],
    ['negative', '-1']
  ])('rejects invalid --timeout-ms: %s', async (_label, value) => {
    await expect(
      ASK_HANDLERS.ask(
        ctx([
          ['spec', VALID_SPEC_JSON],
          ['timeout-ms', value]
        ])
      )
    ).rejects.toThrow(/--timeout-ms/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects invalid --chunk-ms', async () => {
    await expect(
      ASK_HANDLERS.ask(
        ctx([
          ['spec', VALID_SPEC_JSON],
          ['chunk-ms', 'soon']
        ])
      )
    ).rejects.toThrow(/--chunk-ms/)
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects a missing --id on ask wait', async () => {
    await expect(ASK_HANDLERS['ask wait'](ctx([]))).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('rejects a missing --id on ask cancel', async () => {
    await expect(ASK_HANDLERS['ask cancel'](ctx([]))).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
  })
})

describe('orca ask: register -> registered line -> one wait chunk -> envelope', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    callMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  it('prints the registered line before issuing ask.wait, then prints the terminal envelope', async () => {
    callMock
      .mockResolvedValueOnce({ result: { askId: 'ask_1' } })
      .mockResolvedValueOnce({
        result: { status: 'answered', askId: 'ask_1', answers: {}, skipped: [], summary: 'Deploy now?: yes' }
      })

    await ASK_HANDLERS.ask(ctx([['spec', VALID_SPEC_JSON]]))

    expect(callMock).toHaveBeenCalledTimes(2)
    expect(callMock.mock.calls[0][0]).toBe('ask.register')
    expect(callMock.mock.calls[1][0]).toBe('ask.wait')
    expect(logSpy.mock.calls[0][0]).toBe(JSON.stringify({ status: 'registered', askId: 'ask_1' }))
    expect(logSpy.mock.calls[1][0]).toBe(
      JSON.stringify({ status: 'answered', askId: 'ask_1', answers: {}, skipped: [], summary: 'Deploy now?: yes' })
    )
  })

  it('prints a pending envelope carrying the wait instruction when the chunk elapses unanswered', async () => {
    callMock.mockResolvedValueOnce({ result: { askId: 'ask_2' } }).mockResolvedValueOnce({
      result: { status: 'pending', askId: 'ask_2', instruction: 'orca ask wait --id ask_2' }
    })

    await ASK_HANDLERS.ask(ctx([['spec', VALID_SPEC_JSON]]))

    expect(logSpy.mock.calls[1][0]).toBe(
      JSON.stringify({ status: 'pending', askId: 'ask_2', instruction: 'orca ask wait --id ask_2' })
    )
  })

  it('never issues ask.wait when ask.register reports an immediate unavailable outcome (no id)', async () => {
    callMock.mockResolvedValueOnce({ result: { status: 'unavailable', reason: 'no attached ask surface' } })

    await ASK_HANDLERS.ask(ctx([['spec', VALID_SPEC_JSON]]))

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ status: 'unavailable', reason: 'no attached ask surface' })
    )
    // Why: an absent key is the honest encoding of "no ask was ever registered" — a
    // later regression reintroducing `id: null` must fail here, not pass silently.
    const parsed: unknown = JSON.parse(logSpy.mock.calls[0][0] as string)
    expect('id' in (parsed as Record<string, unknown>)).toBe(false)
    expect('askId' in (parsed as Record<string, unknown>)).toBe(false)
  })

  it.each(['answered', 'partial', 'declined', 'timed_out', 'unavailable'])(
    'exits without throwing for terminal status %s',
    async (status) => {
      callMock.mockResolvedValueOnce({ result: { askId: 'ask_3' } }).mockResolvedValueOnce({
        result: { status, askId: 'ask_3', answers: {}, skipped: [], summary: '', ...(status === 'unavailable' ? { reason: 'expired' } : {}) }
      })

      await expect(ASK_HANDLERS.ask(ctx([['spec', VALID_SPEC_JSON]]))).resolves.toBeUndefined()
    }
  )

  it('resends the identical requestId on a transport failure during register', async () => {
    callMock
      .mockRejectedValueOnce(new RuntimeClientError('runtime_unavailable', 'socket closed'))
      .mockResolvedValueOnce({ result: { askId: 'ask_4' } })
      .mockResolvedValueOnce({
        result: { status: 'declined', askId: 'ask_4', answers: {}, skipped: [], summary: '' }
      })

    vi.useFakeTimers()
    // Why: attach the assertion synchronously, before any timer advances, so the
    // rejection this retry swallows internally is never briefly unobserved.
    const assertion = expect(ASK_HANDLERS.ask(ctx([['spec', VALID_SPEC_JSON]]))).resolves.toBeUndefined()
    await vi.runAllTimersAsync()
    await assertion
    vi.useRealTimers()

    const firstRequestId = callMock.mock.calls[0][1].requestId
    const secondRequestId = callMock.mock.calls[1][1].requestId
    expect(typeof firstRequestId).toBe('string')
    expect(firstRequestId.length).toBeGreaterThan(0)
    expect(secondRequestId).toBe(firstRequestId)
  })

  it('resumes the same askId on a transport failure mid-wait, never issuing a second register', async () => {
    callMock
      .mockResolvedValueOnce({ result: { askId: 'ask_5' } })
      .mockRejectedValueOnce(new RuntimeClientError('runtime_unavailable', 'connection reset'))
      .mockResolvedValueOnce({
        result: { status: 'answered', askId: 'ask_5', answers: {}, skipped: [], summary: '' }
      })

    vi.useFakeTimers()
    const assertion = expect(ASK_HANDLERS.ask(ctx([['spec', VALID_SPEC_JSON]]))).resolves.toBeUndefined()
    await vi.runAllTimersAsync()
    await assertion
    vi.useRealTimers()

    expect(callMock).toHaveBeenCalledTimes(3)
    expect(callMock.mock.calls[0][0]).toBe('ask.register')
    expect(callMock.mock.calls[1][0]).toBe('ask.wait')
    expect(callMock.mock.calls[1][1]).toMatchObject({ askId: 'ask_5' })
    expect(callMock.mock.calls[2][0]).toBe('ask.wait')
    expect(callMock.mock.calls[2][1]).toMatchObject({ askId: 'ask_5' })
  })

  it('passes pane/worktree origin env vars verbatim and drops absent ones', async () => {
    delete process.env.ORCA_TERMINAL_HANDLE
    delete process.env.ORCA_WORKSPACE_ID
    process.env.ORCA_PANE_KEY = 'pane_9'
    process.env.ORCA_WORKTREE_ID = 'wt_9'
    try {
      callMock.mockResolvedValueOnce({ result: { askId: 'ask_6' } }).mockResolvedValueOnce({
        result: { status: 'declined', askId: 'ask_6', answers: {}, skipped: [], summary: '' }
      })

      await ASK_HANDLERS.ask(ctx([['spec', VALID_SPEC_JSON]], { cwd: '/repo' }))

      const params = callMock.mock.calls[0][1]
      expect(params).toMatchObject({ cwd: '/repo', paneKey: 'pane_9', worktreeId: 'wt_9' })
      expect(params.terminalHandle).toBeUndefined()
      expect(params.workspaceId).toBeUndefined()
    } finally {
      delete process.env.ORCA_PANE_KEY
      delete process.env.ORCA_WORKTREE_ID
    }
  })
})

describe('orca ask wait', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.mocked(console.log).mockRestore()
  })

  it('issues a single chunk with no registered line', async () => {
    callMock.mockResolvedValueOnce({
      result: { status: 'pending', askId: 'ask_1', instruction: 'orca ask wait --id ask_1' }
    })

    await ASK_HANDLERS['ask wait'](ctx([['id', 'ask_1']]))

    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock).toHaveBeenCalledWith('ask.wait', { askId: 'ask_1', chunkMs: undefined }, expect.any(Object))
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({ status: 'pending', askId: 'ask_1', instruction: 'orca ask wait --id ask_1' })
    )
  })

  it('forwards a custom --chunk-ms', async () => {
    callMock.mockResolvedValueOnce({
      result: { status: 'answered', askId: 'ask_1', answers: {}, skipped: [], summary: '' }
    })

    await ASK_HANDLERS['ask wait'](
      ctx([
        ['id', 'ask_1'],
        ['chunk-ms', '2000']
      ])
    )

    expect(callMock).toHaveBeenCalledWith('ask.wait', { askId: 'ask_1', chunkMs: 2000 }, expect.any(Object))
  })
})

describe('orca ask cancel', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.mocked(console.log).mockRestore()
  })

  it('calls ask.cancel with the given id and prints the returned envelope verbatim', async () => {
    callMock.mockResolvedValueOnce({
      result: { status: 'declined', askId: 'ask_1', answers: {}, skipped: [], summary: '' }
    })

    await ASK_HANDLERS['ask cancel'](ctx([['id', 'ask_1']]))

    expect(callMock).toHaveBeenCalledWith('ask.cancel', { askId: 'ask_1' })
    expect(console.log).toHaveBeenCalledWith(
      JSON.stringify({ status: 'declined', askId: 'ask_1', answers: {}, skipped: [], summary: '' })
    )
  })
})
