import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const handoffModule = vi.hoisted(() => ({
  resolveSessionHandoff: vi.fn(),
  runNativeQuestion: vi.fn()
}))

vi.mock('./native-question-handoff', () => ({
  nativeAskRequestId: (provider: string, sessionId: string, itemId: string) =>
    `native:${provider}:${sessionId}:${itemId}`,
  resolveSessionHandoff: handoffModule.resolveSessionHandoff,
  runNativeQuestion: handoffModule.runNativeQuestion
}))

const { bridgeClaudeAsk } = await import('./claude-native-ask-bridge')
const { NO_OWNER_ANSWER } = await import('./native-question-spec')

const HANDOFF = { origin: { runId: 'run-1', dispatchId: 'dispatch-1', askerHandle: 'w' } }
const INPUT = {
  questions: [
    { question: 'Which database?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }
  ]
}

function options(signal = new AbortController().signal): Parameters<CanUseTool>[2] {
  return { signal, toolUseID: 'tool-1', requestId: 'request-1' }
}

function envelope(status: string, answers: Record<string, unknown> = {}) {
  return { status, askId: 'ask-1', answers, skipped: [], summary: '', reason: 'gone' }
}

describe('bridgeClaudeAsk', () => {
  let inner: ReturnType<typeof vi.fn<CanUseTool>>

  beforeEach(() => {
    handoffModule.resolveSessionHandoff.mockReset()
    handoffModule.runNativeQuestion.mockReset()
    inner = vi.fn<CanUseTool>(async () => ({ behavior: 'allow', toolUseID: 'tool-1' }))
  })

  it('passes every non-question tool straight to the inner callback', async () => {
    handoffModule.resolveSessionHandoff.mockReturnValue(HANDOFF)
    const canUseTool = bridgeClaudeAsk('session-1', inner)

    await canUseTool('Bash', { command: 'ls' }, options())

    expect(inner).toHaveBeenCalledOnce()
    expect(handoffModule.resolveSessionHandoff).not.toHaveBeenCalled()
  })

  it('leaves a question from a session with no forced hand-off to the card', async () => {
    handoffModule.resolveSessionHandoff.mockReturnValue(null)

    await bridgeClaudeAsk('session-1', inner)('AskUserQuestion', INPUT, options())

    expect(inner).toHaveBeenCalledOnce()
    expect(handoffModule.runNativeQuestion).not.toHaveBeenCalled()
  })

  it("answers an owned worker's question with the owner's reply and never calls inner", async () => {
    handoffModule.resolveSessionHandoff.mockReturnValue(HANDOFF)
    handoffModule.runNativeQuestion.mockResolvedValue(
      envelope('answered', { q1: { value: 'o2', label: 'SQLite', source: 'option' } })
    )

    const reply = await bridgeClaudeAsk('session-1', inner)('AskUserQuestion', INPUT, options())

    expect(inner).not.toHaveBeenCalled()
    expect(handoffModule.runNativeQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'native:claude:session-1:tool-1', handoff: HANDOFF })
    )
    expect(reply).toEqual({
      behavior: 'allow',
      updatedInput: { ...INPUT, answers: { 'Which database?': 'SQLite' } },
      toolUseID: 'tool-1'
    })
  })

  it('resolves null when the provider aborts, writing no response', async () => {
    handoffModule.resolveSessionHandoff.mockReturnValue(HANDOFF)
    handoffModule.runNativeQuestion.mockResolvedValue(null)

    await expect(
      bridgeClaudeAsk('session-1', inner)('AskUserQuestion', INPUT, options())
    ).resolves.toBeNull()
  })

  it.each(['timed_out', 'unavailable', 'declined'])(
    'denies with a proceed-on-judgment message when the hand-off ends %s',
    async (status) => {
      handoffModule.resolveSessionHandoff.mockReturnValue(HANDOFF)
      handoffModule.runNativeQuestion.mockResolvedValue(envelope(status))

      await expect(
        bridgeClaudeAsk('session-1', inner)('AskUserQuestion', INPUT, options())
      ).resolves.toEqual({ behavior: 'deny', message: NO_OWNER_ANSWER, toolUseID: 'tool-1' })
    }
  )

  it('denies rather than surfacing a card when the question cannot be relayed', async () => {
    handoffModule.resolveSessionHandoff.mockReturnValue(HANDOFF)

    const reply = await bridgeClaudeAsk('session-1', inner)(
      'AskUserQuestion',
      { questions: [{ question: 'What is your password?' }] },
      options()
    )

    expect(reply).toMatchObject({ behavior: 'deny' })
    expect(inner).not.toHaveBeenCalled()
    expect(handoffModule.runNativeQuestion).not.toHaveBeenCalled()
  })

  it('denies when relaying throws', async () => {
    handoffModule.resolveSessionHandoff.mockReturnValue(HANDOFF)
    handoffModule.runNativeQuestion.mockRejectedValue(new Error('db closed'))

    await expect(
      bridgeClaudeAsk('session-1', inner)('AskUserQuestion', INPUT, options())
    ).resolves.toMatchObject({ behavior: 'deny' })
  })
})
