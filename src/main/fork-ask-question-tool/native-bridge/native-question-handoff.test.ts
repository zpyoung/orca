import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AskSpec } from '../../../shared/fork-ask-question-tool/ask-question-schema'
import {
  createAskRpcHarness,
  type AskRpcHarness
} from '../../runtime/rpc/methods/fork-ask-question-tool/ask-rpc-test-harness'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerIdentities,
  structuredWorkerProcessIncarnation
} from '../../runtime/structured-worker-identity'
import { clearForcedHandoffPolicy, installForcedHandoffPolicy } from '../forced-handoff-policy'
import {
  nativeAskRequestId,
  resolveSessionHandoff,
  runNativeQuestion,
  sweepOrphanedNativeAsks
} from './native-question-handoff'

const SESSION_ID = 'c0ffee00-1111-4222-8333-444455556666'
const SPEC: AskSpec = { questions: [{ id: 'q1', type: 'text', question: 'Which branch?' }] }

function registerWorkerIdentity() {
  return structuredWorkerIdentities.register({
    handle: mintStructuredWorkerHandle(),
    sessionId: SESSION_ID,
    agent: 'claude',
    paneKey: mintStructuredWorkerPaneKey(SESSION_ID),
    processIncarnation: structuredWorkerProcessIncarnation(SESSION_ID),
    worktreeId: 'wt-owned',
    hostScope: { kind: 'local', hostId: 'local' }
  })
}

describe('native question hand-off', () => {
  const harness = createAskRpcHarness()
  let h: AskRpcHarness
  let forcedRuns: Set<string>

  function seedWorkerDispatch(handle: string, paneKey: string) {
    const run = h.orchestrationDb.createRun({
      objective: 'owned watcher run',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    })
    const task = h.orchestrationDb.createTask({ spec: 'do the work', runId: run.id })
    const dispatch = h.orchestrationDb.createDispatchContext({
      taskId: task.id,
      assigneeHandle: handle,
      assigneePaneKey: paneKey,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    return { run, dispatch }
  }

  function answerPending(runId: string, dispatchId: string, body: string): void {
    const [row] = h.askDb.listPending()
    const questionId = row?.handoff_question_id
    if (!questionId) {
      throw new Error('the hand-off question should exist')
    }
    h.orchestrationDb.answerQuestion({
      messageId: questionId,
      runId,
      consumerGeneration: h.orchestrationDb.getRun(runId)?.consumer_generation ?? 0,
      body
    })
    h.runtime.notifyMessageArrived(`dispatch:${dispatchId}`, 'status')
  }

  beforeEach(() => {
    h = harness.setup()
    structuredWorkerIdentities.clear()
    forcedRuns = new Set()
    installForcedHandoffPolicy({
      runtime: h.runtime,
      isForcedRun: (runId) => forcedRuns.has(runId)
    })
  })
  afterEach(() => {
    clearForcedHandoffPolicy()
    structuredWorkerIdentities.clear()
    harness.cleanup()
  })

  it('resolves a forced hand-off for an owned structured worker session', () => {
    const identity = registerWorkerIdentity()
    const { run, dispatch } = seedWorkerDispatch(identity.handle, identity.paneKey)
    forcedRuns.add(run.id)

    expect(resolveSessionHandoff(SESSION_ID)).toMatchObject({
      origin: { runId: run.id, dispatchId: dispatch.id, askerHandle: identity.handle },
      worktreeId: 'wt-owned'
    })
  })

  it('leaves unowned runs, unknown sessions, and uninstalled policies on the normal path', () => {
    const identity = registerWorkerIdentity()
    const { run } = seedWorkerDispatch(identity.handle, identity.paneKey)

    expect(resolveSessionHandoff(SESSION_ID)).toBeNull()
    forcedRuns.add(run.id)
    expect(resolveSessionHandoff('not-a-worker-session')).toBeNull()
    clearForcedHandoffPolicy()
    expect(resolveSessionHandoff(SESSION_ID)).toBeNull()
  })

  it('does not force an owner session, which holds no dispatch', () => {
    registerWorkerIdentity()
    forcedRuns.add('any-run')

    expect(resolveSessionHandoff(SESSION_ID)).toBeNull()
  })

  it("returns the owner's reply as a terminal envelope with no UI pane", async () => {
    const identity = registerWorkerIdentity()
    const { run, dispatch } = seedWorkerDispatch(identity.handle, identity.paneKey)
    forcedRuns.add(run.id)
    const handoff = resolveSessionHandoff(SESSION_ID)
    if (!handoff) {
      throw new Error('expected a forced hand-off')
    }

    const pending = runNativeQuestion({
      handoff,
      spec: SPEC,
      requestId: nativeAskRequestId('claude', SESSION_ID, 'tool-1')
    })
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.askDb.listPending()[0]?.pane_key).toBeNull()
    answerPending(run.id, dispatch.id, 'q1: main')

    await expect(pending).resolves.toMatchObject({
      status: 'answered',
      answers: { q1: { value: 'main', source: 'input' } }
    })
  })

  it('declines the hand-off and resolves null when the provider aborts', async () => {
    const identity = registerWorkerIdentity()
    const { run } = seedWorkerDispatch(identity.handle, identity.paneKey)
    forcedRuns.add(run.id)
    const handoff = resolveSessionHandoff(SESSION_ID)
    if (!handoff) {
      throw new Error('expected a forced hand-off')
    }
    const controller = new AbortController()

    const pending = runNativeQuestion({
      handoff,
      spec: SPEC,
      requestId: nativeAskRequestId('claude', SESSION_ID, 'tool-2'),
      signal: controller.signal
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const [row] = h.askDb.listPending()
    controller.abort()

    await expect(pending).resolves.toBeNull()
    expect(h.askDb.getAsk(row?.ask_id ?? '')?.status).toBe('declined')
  })

  it('stops once the provider no longer wants the answer', async () => {
    const identity = registerWorkerIdentity()
    const { run } = seedWorkerDispatch(identity.handle, identity.paneKey)
    forcedRuns.add(run.id)
    const handoff = resolveSessionHandoff(SESSION_ID)
    if (!handoff) {
      throw new Error('expected a forced hand-off')
    }

    await expect(
      runNativeQuestion({
        handoff,
        spec: SPEC,
        requestId: nativeAskRequestId('codex', SESSION_ID, 'item-1'),
        stillWanted: () => false
      })
    ).resolves.toBeNull()
    expect(h.askDb.listPending()).toEqual([])
  })

  it('sweeps only native hand-offs a previous process left pending', async () => {
    const identity = registerWorkerIdentity()
    const { run, dispatch } = seedWorkerDispatch(identity.handle, identity.paneKey)
    const origin = { runId: run.id, dispatchId: dispatch.id, askerHandle: identity.handle }
    const orphan = await h.registry.register(
      SPEC,
      { paneKey: null, worktreeId: null, handoff: origin },
      { requestId: nativeAskRequestId('codex', SESSION_ID, 'item-orphan') }
    )
    const cliHandoff = await h.registry.register(
      SPEC,
      { paneKey: null, worktreeId: null, handoff: origin },
      { requestId: 'req_cli' }
    )

    sweepOrphanedNativeAsks(h.runtime)

    expect(h.askDb.getAsk(orphan.askId)?.status).toBe('declined')
    expect(h.askDb.getAsk(cliHandoff.askId)?.status).toBe('registered')
  })
})
