import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindOrchestrationSubmissionPreflight } from '../../../../fork-heimdall/orchestration/submission-preflight'
import { createRootDispatch } from '../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../orchestration/rpc-test-harness'

const REJECTION = {
  status: 'rejected' as const,
  code: 'heimdall_submission_rejected',
  reason: 'Correct the watcher report before resubmitting this active Dispatch.'
}
const ACCEPTED = { status: 'accepted' as const }
const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function expectActionableRejection(result: unknown): void {
  if (!result || typeof result !== 'object' || !('lifecycle' in result)) {
    throw new Error('Submission did not return a lifecycle result')
  }
  const lifecycle = result.lifecycle
  if (!lifecycle || typeof lifecycle !== 'object') {
    throw new Error('Submission did not return lifecycle details')
  }
  expect(lifecycle).toMatchObject({
    action: 'rejected',
    code: REJECTION.code,
    reason: expect.any(String)
  })
  if (!('reason' in lifecycle) || typeof lifecycle.reason !== 'string') {
    throw new Error('Submission rejection did not include a reason')
  }
  expect(lifecycle.reason.length).toBeGreaterThan(0)
}

describe('Heimdall orchestration submission preflight', () => {
  const harness = createOrchestrationRpcHarness()

  afterEach(() => harness.cleanup())

  it('keeps a valid worker Dispatch active after rejection and accepts its corrected retry', async () => {
    const { db, runtime, ctx } = harness.setup()
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker' ? WORKER_PANE : harness.coordinatorPaneKey
    )
    const task = db.createTask({ spec: 'Produce a watcher report' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker', WORKER_PANE)
    const params = {
      from: 'term_worker',
      subject: 'Watcher work complete',
      type: 'worker_done',
      payload: JSON.stringify({
        taskId: task.id,
        dispatchId: dispatch.id,
        outcome: 'succeeded'
      })
    }
    bindOrchestrationSubmissionPreflight(
      runtime,
      vi.fn().mockResolvedValueOnce(REJECTION).mockResolvedValue(ACCEPTED)
    )

    const rejected = await harness.call('orchestration.send', params, ctx)

    expectActionableRejection(rejected)
    expect(db.getInbox(100)).toHaveLength(0)
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')

    const accepted = (await harness.call('orchestration.send', params, ctx)) as {
      message: { id: string }
      lifecycle: { action: string }
    }

    expect(accepted.lifecycle.action).toBe('completed')
    expect(db.getInbox(100)).toEqual([
      expect.objectContaining({
        type: 'worker_done',
        from_handle: 'term_worker',
        payload: expect.stringContaining(dispatch.id)
      })
    ])
    expect(db.getTask(task.id)?.status).toBe('completed')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    expect(JSON.parse(db.getTask(task.id)?.result ?? 'null')).toMatchObject({
      provenance: 'worker_report',
      outcome: 'succeeded',
      messageId: accepted.message.id,
      body: '',
      reportPath: null,
      filesModified: []
    })
    expect(db.getAttemptObservationFacts(dispatch.id)).toEqual([
      expect.objectContaining({
        id: `worker_report:${accepted.message.id}`,
        dispatchId: dispatch.id,
        taskId: task.id,
        facet: 'worker_report',
        payload: {
          status: 'accepted',
          outcome: 'succeeded',
          reportId: `worker_report:${accepted.message.id}`
        }
      })
    ])
  })

  it('leaves an ordinary runtime with no watcher binding unaffected', async () => {
    const { db, runtime, ctx } = harness.setup()
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker' ? WORKER_PANE : harness.coordinatorPaneKey
    )
    const task = db.createTask({ spec: 'Ordinary orchestration work' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker', WORKER_PANE)

    const result = (await harness.call(
      'orchestration.send',
      {
        from: 'term_worker',
        subject: 'Ordinary work complete',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'succeeded'
        })
      },
      ctx
    )) as { lifecycle: { action: string } }

    expect(result.lifecycle.action).toBe('completed')
    expect(db.getTask(task.id)?.status).toBe('completed')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    expect(db.getInbox(100)).toHaveLength(1)
  })

  it('does not insert rejected owner status mail and inserts the accepted retry', async () => {
    const { db, runtime, ctx, activeRunId } = harness.setup()
    const subject = 'heimdall-owner-intervention:watcher-1:escalation-1:0'
    const params = {
      from: 'term_owner',
      to: `run:${activeRunId}`,
      subject,
      body: 'ready',
      type: 'status'
    }
    bindOrchestrationSubmissionPreflight(
      runtime,
      vi.fn().mockResolvedValueOnce(REJECTION).mockResolvedValue(ACCEPTED)
    )

    const rejected = await harness.call('orchestration.send', params, ctx)

    expectActionableRejection(rejected)
    expect(db.getInbox(100)).toHaveLength(0)

    const accepted = (await harness.call('orchestration.send', params, ctx)) as {
      message: { id: string; type: string; subject: string }
    }

    expect(accepted.message).toMatchObject({ type: 'status', subject })
    expect(db.getInbox(100)).toEqual([
      expect.objectContaining({ id: accepted.message.id, type: 'status', subject })
    ])
  })
})
