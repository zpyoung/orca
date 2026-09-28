import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexPromptRegistry } from '../../codex/codex-prompt-registry'

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

const { bridgeCodexUserInput } = await import('./codex-native-ask-bridge')
const { NO_OWNER_ANSWER } = await import('./native-question-spec')

const HANDOFF = { origin: { runId: 'run-1', dispatchId: 'dispatch-1', askerHandle: 'w' } }

function userInputRequest(questions: unknown[]) {
  return {
    id: 7,
    method: 'item/tool/requestUserInput',
    params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', questions }
  }
}

const TWO_QUESTIONS = [
  { id: 'target', question: 'Deploy where?', options: [{ label: 'staging' }, { label: 'prod' }] },
  { id: 'reason', question: 'Why?' }
]

function fakeSession() {
  return {
    ended: false,
    prompts: new CodexPromptRegistry(),
    connection: { closed: false, respond: vi.fn(), respondWithError: vi.fn() }
  }
}

type FakeSession = ReturnType<typeof fakeSession>

function bridge(session: FakeSession, request: ReturnType<typeof userInputRequest>): boolean {
  return bridgeCodexUserInput('session-1', session, request)
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('bridgeCodexUserInput', () => {
  beforeEach(() => {
    handoffModule.resolveSessionHandoff.mockReset()
    handoffModule.runNativeQuestion.mockReset()
  })

  it('leaves approvals and unowned sessions to the normal prompt path', () => {
    handoffModule.resolveSessionHandoff.mockReturnValue(null)
    const session = fakeSession()

    expect(bridge(session, userInputRequest(TWO_QUESTIONS))).toBe(false)
    expect(
      bridge(session, { ...userInputRequest([]), method: 'item/commandExecution/requestApproval' })
    ).toBe(false)
    expect(session.prompts.sizes.prompts).toBe(0)
  })

  it("replies once with the owner's answer to every question", async () => {
    handoffModule.resolveSessionHandoff.mockReturnValue(HANDOFF)
    const reply = deferred<unknown>()
    handoffModule.runNativeQuestion.mockReturnValue(reply.promise)
    const session = fakeSession()

    expect(bridge(session, userInputRequest(TWO_QUESTIONS))).toBe(true)
    expect(handoffModule.runNativeQuestion).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'native:codex:session-1:item-1' })
    )
    reply.resolve({
      status: 'partial',
      askId: 'ask-1',
      answers: { q1: { value: 'o2', label: 'prod', source: 'option' } },
      skipped: ['q2'],
      summary: ''
    })
    await vi.waitFor(() => expect(session.connection.respond).toHaveBeenCalledOnce())

    expect(session.connection.respond).toHaveBeenCalledWith(7, {
      answers: { target: { answers: ['prod'] }, reason: { answers: [NO_OWNER_ANSWER] } }
    })
    expect(session.prompts.find('item-1')).toBeNull()
  })

  it('answers with the no-answer text when the hand-off times out', async () => {
    handoffModule.resolveSessionHandoff.mockReturnValue(HANDOFF)
    handoffModule.runNativeQuestion.mockResolvedValue({
      status: 'timed_out',
      askId: 'ask-1',
      answers: {},
      skipped: ['q1', 'q2'],
      summary: ''
    })
    const session = fakeSession()

    bridge(session, userInputRequest(TWO_QUESTIONS))
    await vi.waitFor(() => expect(session.connection.respond).toHaveBeenCalledOnce())

    expect(session.connection.respond).toHaveBeenCalledWith(7, {
      answers: { target: { answers: [NO_OWNER_ANSWER] }, reason: { answers: [NO_OWNER_ANSWER] } }
    })
  })

  it('never replies once the turn that asked has been cleared', async () => {
    handoffModule.resolveSessionHandoff.mockReturnValue(HANDOFF)
    const reply = deferred<unknown>()
    let stillWanted: (() => boolean) | undefined
    handoffModule.runNativeQuestion.mockImplementation((args: { stillWanted: () => boolean }) => {
      stillWanted = args.stillWanted
      return reply.promise
    })
    const session = fakeSession()

    bridge(session, userInputRequest(TWO_QUESTIONS))
    expect(stillWanted?.()).toBe(true)
    session.prompts.clearTurn('thread-1', 'turn-1')
    expect(stillWanted?.()).toBe(false)
    reply.resolve({
      status: 'answered',
      askId: 'ask-1',
      answers: { q1: { value: 'o1', label: 'staging', source: 'option' } },
      skipped: [],
      summary: ''
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(session.connection.respond).not.toHaveBeenCalled()
    expect(session.connection.respondWithError).not.toHaveBeenCalled()
  })

  it('leaves a request with more questions than an ask carries to its normal prompt', () => {
    handoffModule.resolveSessionHandoff.mockReturnValue(HANDOFF)
    const session = fakeSession()
    const questions = Array.from({ length: 11 }, (_, index) => ({
      id: `q${index}`,
      question: `Question ${index}?`
    }))

    expect(bridge(session, userInputRequest(questions))).toBe(false)

    expect(session.connection.respondWithError).not.toHaveBeenCalled()
    expect(handoffModule.runNativeQuestion).not.toHaveBeenCalled()
  })

  it('refuses a secret question with an error reply instead of relaying it', () => {
    handoffModule.resolveSessionHandoff.mockReturnValue(HANDOFF)
    const session = fakeSession()

    expect(
      bridge(session, userInputRequest([{ id: 'key', question: 'Key?', isSecret: true }]))
    ).toBe(true)

    expect(session.connection.respondWithError).toHaveBeenCalledWith(
      7,
      -32001,
      expect.stringContaining('secret')
    )
    expect(handoffModule.runNativeQuestion).not.toHaveBeenCalled()
  })

  it('answers with an error when relaying fails while Codex still waits', async () => {
    handoffModule.resolveSessionHandoff.mockReturnValue(HANDOFF)
    handoffModule.runNativeQuestion.mockRejectedValue(new Error('db closed'))
    const session = fakeSession()

    bridge(session, userInputRequest(TWO_QUESTIONS))
    await vi.waitFor(() => expect(session.connection.respondWithError).toHaveBeenCalledOnce())

    expect(session.connection.respondWithError).toHaveBeenCalledWith(
      7,
      -32001,
      expect.stringContaining('db closed')
    )
  })
})
