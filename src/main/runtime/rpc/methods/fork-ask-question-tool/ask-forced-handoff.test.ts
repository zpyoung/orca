import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearForcedHandoffPolicy,
  installForcedHandoffPolicy
} from '../../../../fork-ask-question-tool/forced-handoff-policy'
import type { OrchestrationDb } from '../../../orchestration/db'
import { createAskRpcHarness, type AskRpcHarness } from './ask-rpc-test-harness'

const WORKER_PANE_KEY = 'tab_worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const COORDINATOR_PANE_KEY = 'tab_coord:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function textSpec() {
  return { questions: [{ id: 'q1', type: 'text', question: 'Which branch should I target?' }] }
}

function seedDispatch(orchestrationDb: OrchestrationDb) {
  const run = orchestrationDb.createRun({
    objective: 'owned watcher run',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: COORDINATOR_PANE_KEY
  })
  const task = orchestrationDb.createTask({ spec: 'do the work', runId: run.id })
  const dispatch = orchestrationDb.createDispatchContext({
    taskId: task.id,
    assigneeHandle: 'term_worker',
    assigneePaneKey: WORKER_PANE_KEY,
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER
  })
  return { run, dispatch }
}

// Heimdall's worktree-scoped fallback reads worker_dispatches, which only the full worker-start flow writes.
function seedWorktreeDispatch(orchestrationDb: OrchestrationDb, worktreeId: string) {
  const run = orchestrationDb.createRun({
    objective: 'owned watcher run',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: COORDINATOR_PANE_KEY
  })
  const task = orchestrationDb.createTask({ spec: 'do the work', runId: run.id })
  const started = orchestrationDb.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  orchestrationDb.prepareStartingWorkerAuthority({
    dispatchId: started.dispatch.id,
    handle: 'term_worker',
    paneKey: WORKER_PANE_KEY,
    processIncarnation: 'runtime:pty:term_worker',
    worktreeId,
    setupState: 'not_applicable',
    effects: []
  })
  return { run, dispatch: started.dispatch }
}

async function registerFromPane(
  h: AskRpcHarness,
  paneKey = WORKER_PANE_KEY,
  handle = 'term_worker'
) {
  h.setPaneOwner(paneKey, handle)
  const registered = await h.call('ask.register', {
    spec: textSpec(),
    requestId: `req_${handle}`,
    paneKey,
    cwd: '/repo'
  })
  const askId =
    typeof registered === 'object' && registered !== null && 'askId' in registered
      ? String(registered.askId)
      : ''
  return { askId }
}

describe('ask.register forced hand-off for owned runs', () => {
  const harness = createAskRpcHarness()
  let h: AskRpcHarness
  let forcedRuns: Set<string>
  let isForcedRun: ReturnType<typeof vi.fn<(runId: string) => boolean>>

  beforeEach(() => {
    h = harness.setup()
    // A capable UI is attached in every case: the point is that it is bypassed only when forced.
    h.hasLocalRendererWindow.value = true
    forcedRuns = new Set()
    isForcedRun = vi.fn((runId: string) => forcedRuns.has(runId))
    installForcedHandoffPolicy({ runtime: h.runtime, isForcedRun })
  })
  afterEach(() => {
    clearForcedHandoffPolicy()
    harness.cleanup()
  })

  it('hands an owned run worker ask off to the run even though a UI could render it', async () => {
    const { run, dispatch } = seedDispatch(h.orchestrationDb)
    forcedRuns.add(run.id)

    const { askId } = await registerFromPane(h)

    const row = h.askDb.getAsk(askId)
    expect(row).toMatchObject({
      origin: 'handoff',
      pane_key: null,
      handoff_run_id: run.id,
      handoff_dispatch_id: dispatch.id
    })
  })

  it('keeps the UI card for a run the policy does not force', async () => {
    seedDispatch(h.orchestrationDb)

    const { askId } = await registerFromPane(h)

    expect(h.askDb.getAsk(askId)).toMatchObject({ origin: 'cli', pane_key: WORKER_PANE_KEY })
  })

  it('keeps the UI card when no policy is installed', async () => {
    const { run } = seedDispatch(h.orchestrationDb)
    forcedRuns.add(run.id)
    clearForcedHandoffPolicy()

    const { askId } = await registerFromPane(h)

    expect(h.askDb.getAsk(askId)).toMatchObject({ origin: 'cli', pane_key: WORKER_PANE_KEY })
  })

  it('keeps the UI card when the asking pane holds no active dispatch', async () => {
    const { askId } = await registerFromPane(h)

    expect(h.askDb.getAsk(askId)).toMatchObject({ origin: 'cli', pane_key: WORKER_PANE_KEY })
    expect(isForcedRun).not.toHaveBeenCalled()
  })

  it('keeps the UI card when the orchestration store cannot be read', async () => {
    const { run } = seedDispatch(h.orchestrationDb)
    forcedRuns.add(run.id)
    vi.spyOn(h.runtime, 'getOrchestrationDb').mockImplementation(() => {
      throw new Error('orchestration.db is locked')
    })

    const { askId } = await registerFromPane(h)

    expect(h.askDb.getAsk(askId)).toMatchObject({ origin: 'cli', pane_key: WORKER_PANE_KEY })
  })

  it('does not force the run coordinator, whose pane is not a dispatch assignee', async () => {
    const { run } = seedDispatch(h.orchestrationDb)
    forcedRuns.add(run.id)

    const { askId } = await registerFromPane(h, COORDINATOR_PANE_KEY, 'term_coord')

    expect(h.askDb.getAsk(askId)).toMatchObject({ origin: 'cli', pane_key: COORDINATOR_PANE_KEY })
  })

  it('never consults the policy for a worktree-only attribution', async () => {
    const { run } = seedWorktreeDispatch(h.orchestrationDb, 'wt-owned')
    forcedRuns.add(run.id)
    h.setKnownWorktree('wt-owned')

    await h.call('ask.register', {
      spec: textSpec(),
      requestId: 'req_worktree',
      worktreeId: 'wt-owned',
      cwd: '/repo'
    })

    expect(isForcedRun).not.toHaveBeenCalled()
  })

  it("delivers the owner's orchestration reply to ask.wait", async () => {
    const { run, dispatch } = seedDispatch(h.orchestrationDb)
    forcedRuns.add(run.id)
    const { askId } = await registerFromPane(h)

    const waitPromise = h.call('ask.wait', { askId, chunkMs: 5000 })
    const questionId = h.askDb.getAsk(askId)?.handoff_question_id ?? ''
    h.orchestrationDb.answerQuestion({
      messageId: questionId,
      runId: run.id,
      consumerGeneration: h.orchestrationDb.getRun(run.id)?.consumer_generation ?? 0,
      body: 'q1: main'
    })
    h.runtime.notifyMessageArrived(`dispatch:${dispatch.id}`, 'status')

    await expect(waitPromise).resolves.toMatchObject({
      status: 'answered',
      askId,
      answers: { q1: { value: 'main', source: 'input' } }
    })
  })

  it('resolves unavailable once the worker is stopped and its dispatch goes inactive', async () => {
    const { run, dispatch } = seedDispatch(h.orchestrationDb)
    forcedRuns.add(run.id)
    const { askId } = await registerFromPane(h)
    h.orchestrationDb.completeDispatch(dispatch.id)

    const envelope = await h.call('ask.wait', { askId, chunkMs: 1000 })

    expect(envelope).toMatchObject({ status: 'unavailable' })
  })
})
