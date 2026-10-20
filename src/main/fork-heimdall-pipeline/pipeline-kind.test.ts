import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AttemptEntry,
  EscalationEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import type { EnrollResult } from '../../shared/fork-heimdall/watcher-types'
import { PipelineEnrollmentPayloadSchema } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import { PIPELINE_ENROLLMENT_TABLES } from './pipeline-enrollment-table'
import {
  createPipelineKindTestHarness,
  pipelineReportPathFromDispatch,
  PIPELINE_AGENT_SOURCE,
  PIPELINE_GATE_SOURCE,
  type PipelineKindTestHarness
} from './pipeline-kind-test-harness'
import { projectPipelineRunView } from './run-view-projection'

vi.mock('electron', () => ({}))

const harnesses: PipelineKindTestHarness[] = []

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()))
})

async function createHarness(
  options: Parameters<typeof createPipelineKindTestHarness>[0] = {}
): Promise<PipelineKindTestHarness> {
  const harness = await createPipelineKindTestHarness(options)
  harnesses.push(harness)
  return harness
}

function enrolled(result: EnrollResult) {
  if (result.status !== 'enrolled') {
    throw new Error(`Expected a new pipeline enrollment; got ${JSON.stringify(result)}`)
  }
  return result.entry.enrollment
}

function latestApprovalEscalation(ledger: WatcherLedger): EscalationEntry {
  const entry = ledger.entries.findLast(
    (candidate): candidate is EscalationEntry =>
      candidate.kind === 'escalation' && candidate.escalationKind === 'awaiting-approval'
  )
  if (entry === undefined) {
    throw new Error('Expected a pending pipeline approval escalation')
  }
  return entry
}

describe('custom pipeline kind through the Heimdall kernel', () => {
  it('dispatches Bugfix with the fingerprint-owned report contract, lands its report, and purges its facts', async () => {
    const harness = await createHarness({
      onDispatch: async (request, context) => {
        const reportPath = pipelineReportPathFromDispatch(request)
        await context.writeReport(reportPath, {
          nodeId: request.taskKey,
          summary: 'Added the null guard to the bugfix path.',
          outputs: { summary: 'Added the null guard.' }
        })
        context.enqueueWorkerDone({
          enrollment: request.enrollment,
          dispatchId: context.dispatchId,
          taskId: request.taskKey ?? 'fix',
          reportPath
        })
        return {
          status: 'dispatched',
          dispatchId: context.dispatchId,
          terminalHandle: 'pipeline-bugfix-terminal'
        }
      }
    })
    const enrollment = enrolled(
      await harness.enroll(PIPELINE_AGENT_SOURCE, {
        runInputs: { task: 'repair the missing null check' }
      })
    )

    await harness.tick(enrollment.watcherId)
    const detail = await harness.service.detail({
      watcherId: enrollment.watcherId,
      connectionId: null,
      pairingRevision: null
    })
    const dispatchAttempt = harness.service
      .ledger(enrollment.watcherId)
      .entries.findLast(
        (entry): entry is AttemptEntry =>
          entry.kind === 'attempt' && entry.action.kind === 'pipeline-dispatch-agent'
      )
    if (dispatchAttempt === undefined) {
      throw new Error('Pipeline Agent did not persist its write-ahead attempt')
    }
    expect(
      dispatchAttempt,
      JSON.stringify({ trace: detail.traces.at(-1), attempt: dispatchAttempt }, null, 2)
    ).toMatchObject({ state: 'running', dispatchId: expect.any(String) })
    expect(harness.dispatched).toHaveLength(1)
    const dispatch = harness.dispatched[0]
    if (dispatch === undefined) {
      throw new Error('Pipeline Agent did not receive its dispatch request')
    }
    const reportPath = pipelineReportPathFromDispatch(dispatch)
    expect(dispatchAttempt.fingerprint).toBe(dispatch.attemptFingerprint)
    expect(dispatchAttempt.dispatch?.spec).toBe(dispatch.spec)
    if (typeof dispatchAttempt.action.spec !== 'string') {
      throw new Error('Pipeline Agent did not preserve its approved task spec')
    }
    expect(dispatchAttempt.action.spec).not.toContain(reportPath)

    await harness.tick(enrollment.watcherId)
    expect(harness.mailboxDelivered).toContainEqual(
      expect.objectContaining({
        kind: 'evidence',
        evidenceKind: 'orchestration-mailbox',
        payload: expect.objectContaining({
          type: 'worker_done',
          payload: expect.objectContaining({
            dispatchId: expect.any(String),
            reportPath,
            outcome: 'succeeded'
          })
        })
      })
    )
    expect(harness.pipelineStore.facts(enrollment.watcherId).outputs).toContainEqual(
      expect.objectContaining({
        instanceId: 'fix',
        outputs: { summary: 'Added the null guard.' }
      })
    )
    const finished = (await harness.service.list()).find(
      (entry) => entry.enrollment.watcherId === enrollment.watcherId
    )
    expect(finished).toMatchObject({
      enrollment: { enabled: false, terminalAtMs: expect.any(Number) },
      status: { state: 'terminal' }
    })
    if (finished === undefined) {
      throw new Error('Pipeline completion did not return its terminal run view entry')
    }
    const terminalFacts = harness.pipelineStore.facts(enrollment.watcherId)
    const terminalNodeState = terminalFacts.terminalNodeStates?.find(
      (node) => node.instanceId === 'fix'
    )
    if (terminalNodeState === undefined) {
      throw new Error('Pipeline completion did not retain its node projection')
    }
    expect(terminalNodeState).toMatchObject({
      instanceId: 'fix',
      status: 'done',
      epoch: 0,
      attempt: 0,
      startedAtMs: expect.any(Number),
      elapsedMs: expect.any(Number),
      turns: expect.any(Number)
    })
    expect(terminalNodeState.elapsedMs).toBeGreaterThan(0)
    expect(terminalNodeState.turns).toBeGreaterThan(0)
    const compactedView = projectPipelineRunView({
      entry: finished,
      ledger: harness.service.ledger(enrollment.watcherId),
      facts: terminalFacts,
      nowMs: 100_000,
      unverifiableDispatchIds: new Set()
    })
    expect(compactedView.nodes.find((node) => node.instanceId === 'fix')).toMatchObject({
      status: 'done',
      startedAtMs: terminalNodeState.startedAtMs,
      elapsedMs: terminalNodeState.elapsedMs,
      turns: terminalNodeState.turns
    })
    expect(harness.service.ledger(enrollment.watcherId).entries.map((entry) => entry.kind)).toEqual(
      ['terminal']
    )

    await expect(harness.command(enrollment.watcherId, { kind: 'delete' })).resolves.toMatchObject({
      status: 'applied'
    })
    expect(harness.enrollmentStore.get(enrollment.watcherId)).toBeNull()
    expect(harness.pipelineStore.facts(enrollment.watcherId)).toMatchObject({
      pin: null,
      outputs: [],
      dispatches: [],
      swarmExpansions: [],
      childWorktrees: [],
      mergeProgress: [],
      composites: []
    })
    expect(
      harness.pipelineStore.attemptBaseline(enrollment.watcherId, dispatch.attemptFingerprint)
    ).toBeNull()
  })

  it('rolls back a new pipeline enrollment when run-pin storage fails before activation', async () => {
    const harness = await createHarness()
    harness.pipelineDatabase.connection().exec(`
      CREATE TRIGGER reject_pipeline_run_pin
      BEFORE INSERT ON pipeline_run_pin
      BEGIN
        SELECT RAISE(ABORT, 'run-pin storage failure');
      END;
    `)

    await expect(harness.enroll(PIPELINE_AGENT_SOURCE)).rejects.toThrow('run-pin storage failure')

    expect(harness.enrollmentStore.list()).toEqual([])
    expect(await harness.service.list()).toEqual([])
    expect(harness.dispatched).toEqual([])
    expect(
      harness.pipelineDatabase
        .connection()
        .prepare('SELECT COUNT(*) AS count FROM pipeline_run_pin')
        .get()?.count
    ).toBe(0)
  })

  it('holds a human gate for approval instead of reporting a disabled gate capability, then aborts on the person’s choice', async () => {
    const harness = await createHarness()
    const enrollment = enrolled(await harness.enroll(PIPELINE_GATE_SOURCE))

    await harness.tick(enrollment.watcherId)
    const listed = (await harness.service.list()).find(
      (entry) => entry.enrollment.watcherId === enrollment.watcherId
    )
    expect(enrollment.capabilities.gate).toBe('on')
    expect(listed?.status).toMatchObject({
      state: 'held',
      phase: 'gate',
      reason: 'awaiting-approval'
    })
    const ledger = harness.service.ledger(enrollment.watcherId)
    const pending = latestApprovalEscalation(ledger)
    expect(pending).toMatchObject({
      approvalScope: { actionKind: 'pipeline-pass-gate' }
    })
    if (pending.approvalScope === undefined) {
      throw new Error('The pending gate does not identify its approval scope')
    }

    await expect(
      harness.command(enrollment.watcherId, {
        kind: 'answer-pipeline-choice',
        scope: pending.approvalScope,
        choice: 'abort',
        attribution: {
          actor: { user: 'pipeline-test-user', host: 'localhost' },
          surface: 'heimdall-detail',
          atMs: 21_000
        }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    await harness.tick(enrollment.watcherId)
    const abortedLedger = harness.service.ledger(enrollment.watcherId)
    expect(abortedLedger.entries).toContainEqual(
      expect.objectContaining({ kind: 'terminal', reason: 'pipeline-aborted' })
    )
    expect(
      (await harness.service.list()).find(
        (entry) => entry.enrollment.watcherId === enrollment.watcherId
      )
    ).toMatchObject({ enrollment: { enabled: false }, status: { state: 'terminal' } })
  })

  it('stops a persisted schemaVersion mismatch as a configuration error before dispatch', async () => {
    const harness = await createHarness()
    const enrollment = enrolled(await harness.enroll(PIPELINE_AGENT_SOURCE))
    const payload = PipelineEnrollmentPayloadSchema.parse(enrollment.kindPayload)
    const invalidPayload = { ...payload, schemaVersion: 2 }
    harness.database
      .connection()
      .prepare(
        `UPDATE ${PIPELINE_ENROLLMENT_TABLES.enrollment}
            SET kind_payload_json = ?
          WHERE watcher_id = ?`
      )
      .run(JSON.stringify(invalidPayload), enrollment.watcherId)

    await harness.tick(enrollment.watcherId)

    const listed = (await harness.service.list()).find(
      (entry) => entry.enrollment.watcherId === enrollment.watcherId
    )
    const detail = await harness.service.detail({
      watcherId: enrollment.watcherId,
      connectionId: null,
      pairingRevision: null
    })
    expect(detail.traces.at(-1)?.snapshot).toMatchObject({
      configurationError: 'kindPayload.schemaVersion'
    })
    expect(listed).toMatchObject({
      enrollment: { enabled: false },
      status: {
        state: 'parked',
        phase: 'parked',
        reason: 'pipeline-configuration-error',
        parkReason: {
          kind: 'stop-predicate',
          predicateId: 'pipeline-configuration-error'
        }
      }
    })
    expect(harness.dispatched).toEqual([])
    expect(harness.service.ledger(enrollment.watcherId).entries).toContainEqual(
      expect.objectContaining({
        kind: 'escalation',
        escalationKind: 'park-stop-predicate'
      })
    )
  })
})
