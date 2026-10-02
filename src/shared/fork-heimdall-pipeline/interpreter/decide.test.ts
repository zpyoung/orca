import { describe, expect, it } from 'vitest'
import type { ApprovalScope, KernelAction, WatcherLedger } from '../../fork-heimdall/ledger-types'
import {
  ownerDeviationEscalationId,
  type PipelineNodeDeviation
} from '../../fork-heimdall/owner/deviation'
import type { DecisionOutcome } from '../../fork-heimdall/kind-contract'
import { parsePipelineNodeEvidenceKey } from '../choice-types'
import {
  answerEvidence,
  attemptEntry,
  emptyLedger,
  nodeOutputs,
  ownerEscalation,
  pipelinePayload,
  world
} from '../interpreter-test-harness'
import { decidePipelineTick, derivePipelineRunState, type PipelineWorld } from './index'

type Outcome = DecisionOutcome<KernelAction>

function actionFrom(outcome: Outcome): KernelAction {
  if (!('action' in outcome) || outcome.action === null) {
    throw new Error('Expected an interpreter action')
  }
  return outcome.action
}

function deviationFrom(outcome: Outcome): PipelineNodeDeviation {
  if (!('deviation' in outcome) || outcome.deviation.kind !== 'pipeline-node') {
    throw new Error('Expected a pipeline node owner deviation')
  }
  return outcome.deviation
}

function append(ledger: WatcherLedger, ...entries: WatcherLedger['entries']): WatcherLedger {
  return { ...ledger, entries: [...ledger.entries, ...entries] }
}

function actionScope(action: KernelAction): ApprovalScope {
  return {
    actionKind: action.kind,
    contentIdentity: action.contentIdentity,
    evidenceKey: action.evidenceKey
  }
}

function runState(worldSnapshot: PipelineWorld, ledger: WatcherLedger) {
  return derivePipelineRunState({
    payload: worldSnapshot.payload,
    ledger,
    facts: worldSnapshot.facts,
    nowMs: worldSnapshot.nowMs,
    hasOwner: worldSnapshot.hasOwner,
    unverifiableDispatchIds: worldSnapshot.unverifiableDispatchIds,
    composites: worldSnapshot.composites
  })
}

function decodedKey(action: KernelAction) {
  const parsed = parsePipelineNodeEvidenceKey(action.evidenceKey)
  if (parsed === null) {
    throw new Error(`Expected a pipeline node evidence key, got ${action.evidenceKey}`)
  }
  return parsed
}

describe('decidePipelineTick retry behavior', () => {
  it('allows retry: 2 exactly three executions and carries the previous failure into the next attempt', () => {
    const payload = pipelinePayload(`version: 1
id: retries
name: Retries
nodes:
  - id: fix
    type: agent
    prompt: Fix the issue
    retry: 2
`)
    const run = world({ payload })
    let ledger = emptyLedger()
    const executions: KernelAction[] = []

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const action = actionFrom(decidePipelineTick(run, ledger))
      executions.push(action)
      expect(action.kind).toBe('pipeline-dispatch-agent')
      expect(decodedKey(action)).toMatchObject({ instanceId: 'fix', epoch: 0, attempt })

      if (attempt === 1) {
        expect(action.spec).toContain('## Retry context')
        expect(action.spec).toContain('The worker rejected the previous implementation')
      }

      ledger = append(
        ledger,
        attemptEntry(action, 'settled', 2_000 + attempt, {
          attemptId: `fix-attempt-${attempt}`,
          effect: 'not-landed',
          reason: 'The worker rejected the previous implementation'
        })
      )

      if (attempt < 2) {
        const next = actionFrom(decidePipelineTick(run, ledger))
        expect(next.kind).toBe('pipeline-dispatch-agent')
        expect(decodedKey(next)).toMatchObject({
          instanceId: 'fix',
          epoch: 0,
          attempt: attempt + 1
        })
      }
    }

    expect(executions).toHaveLength(3)
    const exhausted = actionFrom(decidePipelineTick(run, ledger))
    expect(exhausted).toMatchObject({
      kind: 'pipeline-apply-choice',
      cause: 'retries-exhausted',
      options: ['retry', 'skip', 'abort'],
      approvalRequired: true
    })
    expect(decodedKey(exhausted)).toMatchObject({ instanceId: 'fix', epoch: 0, attempt: 3 })
  })

  it('offers send-back when an exhausted Agent failure has an onFail repair route', () => {
    const payload = pipelinePayload(`version: 1
id: retry-send-back
name: Retry send-back
nodes:
  - id: planner
    type: agent
    prompt: Plan the work
  - id: fix
    type: agent
    after: [planner]
    prompt: Fix the issue
    retry: 0
    onFail:
      sendBackTo: planner
`)
    const run = world({
      payload,
      facts: {
        ...world({ payload }).facts,
        outputs: [nodeOutputs('planner', 0, 0, {})]
      }
    })
    const plannerDispatch = actionFrom(decidePipelineTick(run, emptyLedger()))
    expect(plannerDispatch.kind).toBe('pipeline-dispatch-agent')
    expect(decodedKey(plannerDispatch).instanceId).toBe('planner')
    let ledger = append(
      emptyLedger(),
      attemptEntry(plannerDispatch, 'settled', 2_000, {
        effect: 'landed',
        attemptId: 'planner-for-sendback'
      })
    )
    const dispatch = actionFrom(decidePipelineTick(run, ledger))
    expect(dispatch.kind).toBe('pipeline-dispatch-agent')
    expect(decodedKey(dispatch).instanceId).toBe('fix')
    ledger = append(
      ledger,
      attemptEntry(dispatch, 'settled', 2_001, {
        effect: 'not-landed',
        reason: 'The repair did not pass review'
      })
    )

    const choice = actionFrom(decidePipelineTick(run, ledger))
    expect(choice).toMatchObject({
      kind: 'pipeline-apply-choice',
      cause: 'retries-exhausted',
      options: ['retry', 'skip', 'send-back', 'abort'],
      approvalRequired: true
    })
  })

  it.each([
    {
      nodeType: 'agent',
      node: `type: agent\nprompt: Repair the issue`,
      actionKind: 'pipeline-dispatch-agent'
    },
    {
      nodeType: 'check',
      node: `type: check\ncommand: npm test`,
      actionKind: 'pipeline-run-check'
    }
  ])(
    'keeps retry: 2 bounded across $nodeType onFail.sendBackTo repair epochs',
    ({ node, actionKind }) => {
      const payload = pipelinePayload(`version: 1
id: bounded-repair
name: Bounded repair
nodes:
  - id: planner
    type: agent
    prompt: Repair the issue
  - id: trigger
    ${node.replace(/\n/g, '\n    ')}
    after: [planner]
    retry: 2
    onFail:
      sendBackTo: planner
`)
      const run = world({
        payload,
        facts: {
          ...world({ payload }).facts,
          outputs: [0, 1, 2].map((epoch) => nodeOutputs('planner', epoch, 0, {}))
        }
      })
      let ledger = emptyLedger()
      const failedExecutions: KernelAction[] = []

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const plannerDispatch = actionFrom(decidePipelineTick(run, ledger))
        expect(plannerDispatch.kind).toBe('pipeline-dispatch-agent')
        expect(decodedKey(plannerDispatch)).toMatchObject({
          instanceId: 'planner',
          epoch: attempt,
          attempt: 0
        })
        ledger = append(
          ledger,
          attemptEntry(plannerDispatch, 'settled', 3_000 + attempt * 2, {
            effect: 'landed',
            attemptId: `planner-epoch-${attempt}`
          })
        )

        const execution = actionFrom(decidePipelineTick(run, ledger))
        failedExecutions.push(execution)
        expect(execution.kind).toBe(actionKind)
        expect(decodedKey(execution)).toMatchObject({
          instanceId: 'trigger',
          epoch: attempt,
          attempt
        })
        ledger = append(
          ledger,
          attemptEntry(execution, 'settled', 3_001 + attempt * 2, {
            attemptId: `trigger-${actionKind}-${attempt}`,
            effect: 'not-landed',
            reason: `Repair execution ${attempt + 1} failed`
          })
        )
      }

      expect(failedExecutions).toHaveLength(3)
      const state = runState(run, ledger)
      expect(state.nodes.get('trigger')).toMatchObject({ status: 'failed', epoch: 2, attempt: 3 })
      const exhausted = actionFrom(decidePipelineTick(run, ledger))
      expect(exhausted).toMatchObject({
        kind: 'pipeline-apply-choice',
        cause: 'retries-exhausted',
        options: ['retry', 'skip', 'send-back', 'abort']
      })
      expect(decodedKey(exhausted)).toMatchObject({ instanceId: 'trigger', epoch: 2, attempt: 3 })
    }
  )
})

describe('decidePipelineTick gates and owner routing', () => {
  it('passes a gate only after its approve control attempt lands', () => {
    const payload = pipelinePayload(`version: 1
id: gate
name: Gate
nodes:
  - id: approval
    type: gate
    label: Review the change
`)
    const run = world({ payload })
    const initial = actionFrom(decidePipelineTick(run, emptyLedger()))
    expect(initial).toMatchObject({
      kind: 'pipeline-pass-gate',
      capability: 'gate',
      approvalRequired: true,
      options: ['approve', 'abort']
    })
    expect(decodedKey(initial)).toMatchObject({
      instanceId: 'approval',
      epoch: 0,
      attempt: 0,
      cause: 'gate'
    })

    const intent = answerEvidence(actionScope(initial), 'approve')
    const answeredLedger = append(emptyLedger(), intent)
    expect(runState(run, answeredLedger).nodes.get('approval')).toMatchObject({
      status: 'ready',
      epoch: 0,
      attempt: 0
    })
    const pending = actionFrom(decidePipelineTick(run, answeredLedger))
    expect(pending.kind).toBe('pipeline-pass-gate')

    const landedLedger = append(
      answeredLedger,
      attemptEntry(pending, 'settled', 2_000, {
        effect: 'landed',
        attemptId: 'gate-approve-landed'
      })
    )
    expect(runState(run, landedLedger).nodes.get('approval')).toMatchObject({
      status: 'done',
      epoch: 0,
      attempt: 0,
      outputs: { decision: 'approve' }
    })
  })

  it('lets a ready Agent sibling run before a gate holds the next decision', () => {
    const payload = pipelinePayload(`version: 1
id: gate-sibling
name: Gate and sibling
nodes:
  - id: approval
    type: gate
    label: Review the change
  - id: sibling
    type: agent
    prompt: Continue independent work
`)
    const run = world({ payload })
    const sibling = actionFrom(decidePipelineTick(run, emptyLedger()))
    expect(sibling.kind).toBe('pipeline-dispatch-agent')
    expect(decodedKey(sibling).instanceId).toBe('sibling')

    const siblingRunning = append(
      emptyLedger(),
      attemptEntry(sibling, 'running', 2_000, {
        attemptId: 'gate-sibling-running',
        dispatchId: 'gate-sibling-dispatch'
      })
    )
    expect(runState(run, siblingRunning).nodes.get('sibling')?.status).toBe('running')
    expect(runState(run, siblingRunning).nodes.get('approval')?.status).toBe('ready')

    const gate = actionFrom(decidePipelineTick(run, siblingRunning))
    expect(gate).toMatchObject({
      kind: 'pipeline-pass-gate',
      capability: 'gate',
      approvalRequired: true
    })
    expect(decodedKey(gate)).toMatchObject({ instanceId: 'approval', cause: 'gate' })
  })

  it('keeps an open deviation branch-local, orders an escalated choice after siblings, and applies a resolved skip', () => {
    const payload = pipelinePayload(`version: 1
id: owner-branches
name: Owner branches
nodes:
  - id: blocked
    type: agent
    prompt: Fix the issue
    retry: 0
  - id: sibling
    type: agent
    prompt: Continue independent work
`)
    const run = world({ payload })
    const first = actionFrom(decidePipelineTick(run, emptyLedger()))
    expect(decodedKey(first).instanceId).toBe('blocked')
    let ledger = append(
      emptyLedger(),
      attemptEntry(first, 'settled', 2_000, {
        effect: 'not-landed',
        reason: 'The worker could not fix the issue'
      })
    )
    const ownerRun = world({ payload, hasOwner: true })
    const newDeviation = deviationFrom(decidePipelineTick(ownerRun, ledger))
    expect(newDeviation).toMatchObject({
      kind: 'pipeline-node',
      nodeInstanceId: 'blocked',
      epoch: 0,
      cause: 'retries-exhausted',
      options: ['retry', 'skip', 'abort']
    })

    ledger = append(ledger, ownerEscalation(newDeviation, 'open'))
    const openBranchResult = actionFrom(decidePipelineTick(ownerRun, ledger))
    expect(openBranchResult.kind).toBe('pipeline-dispatch-agent')
    expect(decodedKey(openBranchResult).instanceId).toBe('sibling')

    ledger = append(ledger, ownerEscalation(newDeviation, 'escalated'))
    const siblingFirst = actionFrom(decidePipelineTick(ownerRun, ledger))
    expect(siblingFirst.kind).toBe('pipeline-dispatch-agent')
    expect(decodedKey(siblingFirst).instanceId).toBe('sibling')

    ledger = append(
      ledger,
      attemptEntry(siblingFirst, 'running', 2_004, {
        attemptId: 'sibling-running',
        dispatchId: 'sibling-dispatch'
      })
    )
    const personChoice = actionFrom(decidePipelineTick(ownerRun, ledger))
    expect(personChoice).toMatchObject({
      kind: 'pipeline-apply-choice',
      cause: 'retries-exhausted',
      options: ['retry', 'skip', 'abort']
    })
    expect(decodedKey(personChoice)).toMatchObject({ instanceId: 'blocked', epoch: 0 })

    const resolvedLedger = append(
      ledger,
      ownerEscalation(newDeviation, 'resolved'),
      answerEvidence(actionScope(personChoice), 'skip'),
      attemptEntry(personChoice, 'settled', 2_006, {
        effect: 'landed',
        attemptId: 'owner-skip-landed'
      })
    )
    const finalState = runState(ownerRun, resolvedLedger)
    expect(finalState.nodes.get('blocked')?.status).toBe('skipped')
    expect(finalState.nodes.get('sibling')?.status).toBe('running')
    expect(decidePipelineTick(ownerRun, resolvedLedger).action).toBeNull()
  })

  it('returns a fresh owner deviation when a resolved retry fails in a later epoch', () => {
    const payload = pipelinePayload(`version: 1
id: owner-recurrence
name: Owner recurrence
nodes:
  - id: worker
    type: agent
    prompt: Fix the issue
    retry: 0
`)
    const run = world({ payload, hasOwner: true })
    const dispatch = actionFrom(decidePipelineTick(run, emptyLedger()))
    const firstFailure = append(
      emptyLedger(),
      attemptEntry(dispatch, 'settled', 2_000, {
        effect: 'not-landed',
        reason: 'The first epoch failed'
      })
    )
    const firstDeviation = deviationFrom(decidePipelineTick(run, firstFailure))
    const escalated = append(firstFailure, ownerEscalation(firstDeviation, 'escalated'))
    const choice = actionFrom(decidePipelineTick(run, escalated))
    const answered = append(escalated, answerEvidence(actionScope(choice), 'retry'))
    const retryControl = actionFrom(decidePipelineTick(run, answered))
    expect(retryControl).toMatchObject({ kind: 'pipeline-apply-choice', choice: 'retry' })

    const resolvedLedger = append(
      answered,
      ownerEscalation(firstDeviation, 'resolved'),
      attemptEntry(retryControl, 'settled', 2_003, {
        effect: 'landed',
        attemptId: 'owner-retry-landed'
      })
    )
    expect(runState(run, resolvedLedger).nodes.get('worker')).toMatchObject({
      status: 'ready',
      epoch: 1,
      attempt: 0
    })
    const retryDispatch = actionFrom(decidePipelineTick(run, resolvedLedger))
    expect(decodedKey(retryDispatch)).toMatchObject({ instanceId: 'worker', epoch: 1, attempt: 0 })
    const secondFailure = append(
      resolvedLedger,
      attemptEntry(retryDispatch, 'settled', 2_004, {
        effect: 'not-landed',
        attemptId: 'owner-retry-failed',
        reason: 'The retried epoch failed'
      })
    )

    const recurrence = deviationFrom(decidePipelineTick(run, secondFailure))
    expect(recurrence).toMatchObject({
      kind: 'pipeline-node',
      nodeInstanceId: 'worker',
      epoch: 1,
      attempt: 1,
      cause: 'retries-exhausted'
    })
    expect(ownerDeviationEscalationId('watcher-1', recurrence)).not.toBe(
      ownerDeviationEscalationId('watcher-1', firstDeviation)
    )
  })
})

describe('decidePipelineTick time limits and live workers', () => {
  it('binds each time-limit decision to its deadline and commits Extend only after a landed control attempt', () => {
    const payload = pipelinePayload(`version: 1
id: timed
name: Timed
nodes:
  - id: worker
    type: agent
    prompt: Do the work
    timeLimitMinutes: 1
`)
    const dispatchWorld = world({ payload })
    const dispatch = actionFrom(decidePipelineTick(dispatchWorld, emptyLedger()))
    const startMs = 1_000
    const firstDeadlineMs = startMs + 60_000
    const dispatchId = 'worker-dispatch'
    const facts = {
      ...dispatchWorld.facts,
      dispatches: [
        {
          instanceId: 'worker',
          epoch: 0,
          attempt: 0,
          dispatchId,
          workspaceId: null,
          terminalHandle: null,
          reportPath: '/workspace/.orca/worker-report.json',
          dispatchedAtMs: startMs
        }
      ]
    }
    const workerLedger = append(
      emptyLedger(),
      attemptEntry(dispatch, 'running', startMs, { attemptId: 'worker-live', dispatchId })
    )
    const expiredWorld = world({ payload, facts, nowMs: firstDeadlineMs, hasOwner: true })
    const firstOwnerChoice = deviationFrom(decidePipelineTick(expiredWorld, workerLedger))
    expect(firstOwnerChoice).toMatchObject({
      kind: 'pipeline-node',
      nodeInstanceId: 'worker',
      epoch: 0,
      attempt: 0,
      cause: 'time-limit',
      deadlineMs: firstDeadlineMs,
      options: ['extend', 'retry', 'skip', 'abort']
    })

    let ledger = append(workerLedger, ownerEscalation(firstOwnerChoice, 'escalated'))
    const firstAction = actionFrom(decidePipelineTick(expiredWorld, ledger))
    expect(firstAction).toMatchObject({
      kind: 'pipeline-apply-choice',
      cause: 'time-limit',
      deadlineMs: firstDeadlineMs,
      options: ['extend', 'retry', 'skip', 'abort']
    })
    const firstKey = decodedKey(firstAction)
    expect(firstKey).toMatchObject({
      instanceId: 'worker',
      epoch: 0,
      attempt: 0,
      cause: 'time-limit',
      deadlineMs: firstDeadlineMs
    })

    ledger = append(
      ledger,
      answerEvidence(actionScope(firstAction), 'extend', { extendMinutes: 10 })
    )
    const answeredAction = actionFrom(decidePipelineTick(expiredWorld, ledger))
    expect(answeredAction).toMatchObject({
      kind: 'pipeline-apply-choice',
      cause: 'time-limit',
      deadlineMs: firstDeadlineMs,
      choice: 'extend',
      extendMinutes: 10
    })
    const intentState = runState(expiredWorld, ledger)
    expect(intentState.nodes.get('worker')).toMatchObject({
      status: 'running',
      epoch: 0,
      attempt: 0
    })
    expect(intentState.deadlines).toEqual([{ instanceId: 'worker', atMs: firstDeadlineMs }])

    ledger = append(
      ledger,
      attemptEntry(answeredAction, 'settled', firstDeadlineMs + 1, {
        effect: 'not-landed',
        attemptId: 'extend-control-failed',
        reason: 'The first control attempt did not land'
      })
    )
    const retriedControl = actionFrom(
      decidePipelineTick(world({ ...expiredWorld, nowMs: firstDeadlineMs + 1 }), ledger)
    )
    expect(retriedControl).toMatchObject({
      kind: 'pipeline-apply-choice',
      cause: 'time-limit',
      deadlineMs: firstDeadlineMs,
      choice: 'extend',
      extendMinutes: 10
    })
    expect(retriedControl.evidenceKey).toBe(answeredAction.evidenceKey)

    ledger = append(
      ledger,
      attemptEntry(retriedControl, 'settled', firstDeadlineMs + 2, {
        effect: 'landed',
        attemptId: 'extend-control-landed'
      })
    )
    const extensionMs = 10 * 60_000
    const secondDeadlineMs = firstDeadlineMs + extensionMs
    const extendedState = runState(world({ ...expiredWorld, nowMs: firstDeadlineMs + 2 }), ledger)
    expect(extendedState.nodes.get('worker')).toMatchObject({
      status: 'running',
      epoch: 0,
      attempt: 0
    })
    expect(extendedState.deadlines).toEqual([{ instanceId: 'worker', atMs: secondDeadlineMs }])

    const secondExpiryWorld = world({ ...expiredWorld, nowMs: secondDeadlineMs })
    const secondOwnerChoice = deviationFrom(decidePipelineTick(secondExpiryWorld, ledger))
    expect(secondOwnerChoice).toMatchObject({
      kind: 'pipeline-node',
      nodeInstanceId: 'worker',
      epoch: 0,
      attempt: 0,
      cause: 'time-limit',
      deadlineMs: secondDeadlineMs
    })
    ledger = append(ledger, ownerEscalation(secondOwnerChoice, 'escalated'))
    const secondAction = actionFrom(decidePipelineTick(secondExpiryWorld, ledger))
    expect(secondAction).toMatchObject({
      kind: 'pipeline-apply-choice',
      cause: 'time-limit',
      deadlineMs: secondDeadlineMs
    })
    expect(decodedKey(secondAction)).toMatchObject({
      deadlineMs: secondDeadlineMs,
      epoch: 0,
      attempt: 0
    })
    expect(secondAction.evidenceKey).not.toBe(firstAction.evidenceKey)
  })

  it('keeps an answered Retry control ahead of a worker failure until the control lands', () => {
    const payload = pipelinePayload(`version: 1
id: timed-retry
name: Timed retry
nodes:
  - id: worker
    type: agent
    prompt: Do the work
    retry: 0
    timeLimitMinutes: 1
`)
    const run = world({ payload })
    const dispatch = actionFrom(decidePipelineTick(run, emptyLedger()))
    const dispatchId = 'retry-worker-dispatch'
    const facts = {
      ...run.facts,
      dispatches: [
        {
          instanceId: 'worker',
          epoch: 0,
          attempt: 0,
          dispatchId,
          workspaceId: null,
          terminalHandle: null,
          reportPath: '/workspace/.orca/worker-report.json',
          dispatchedAtMs: 1_000
        }
      ]
    }
    const timeWorld = world({ payload, facts, nowMs: 61_000 })
    const running = append(
      emptyLedger(),
      attemptEntry(dispatch, 'running', 1_000, { attemptId: 'retry-worker-live', dispatchId })
    )
    const expiredChoice = actionFrom(decidePipelineTick(timeWorld, running))
    const withIntent = append(running, answerEvidence(actionScope(expiredChoice), 'retry'))
    const stoppedWorker = append(
      withIntent,
      attemptEntry(dispatch, 'settled', 62_000, {
        attemptId: 'retry-worker-failed',
        effect: 'not-landed',
        reason: 'The worker exited without a result'
      })
    )

    const outcome = decidePipelineTick(world({ ...timeWorld, nowMs: 62_000 }), stoppedWorker)
    const control = actionFrom(outcome)
    expect(control).toMatchObject({
      kind: 'pipeline-apply-choice',
      cause: 'time-limit',
      choice: 'retry'
    })
    expect(decodedKey(control)).toMatchObject({
      instanceId: 'worker',
      epoch: 0,
      attempt: 0,
      cause: 'time-limit'
    })
  })

  it('leaves an unverifiable dispatch live instead of failing or time-limiting it', () => {
    const payload = pipelinePayload(`version: 1
id: unverifiable
name: Unverifiable
nodes:
  - id: worker
    type: agent
    prompt: Do the work
    retry: 2
    timeLimitMinutes: 1
`)
    const run = world({ payload })
    const dispatch = actionFrom(decidePipelineTick(run, emptyLedger()))
    const dispatchId = 'unverifiable-worker'
    const facts = {
      ...run.facts,
      dispatches: [
        {
          instanceId: 'worker',
          epoch: 0,
          attempt: 0,
          dispatchId,
          workspaceId: null,
          terminalHandle: null,
          reportPath: '/workspace/.orca/worker-report.json',
          dispatchedAtMs: 1_000
        }
      ]
    }
    const running = append(
      emptyLedger(),
      attemptEntry(dispatch, 'running', 1_000, { attemptId: 'unverifiable-running', dispatchId })
    )
    const unverifiableWorld = world({
      payload,
      facts,
      nowMs: 61_000,
      unverifiableDispatchIds: new Set([dispatchId])
    })

    const state = runState(unverifiableWorld, running)
    expect(state.nodes.get('worker')).toMatchObject({
      status: 'unverifiable',
      epoch: 0,
      attempt: 0
    })
    expect(state.nodes.get('worker')?.status).not.toBe('failed')
    expect(state.deadlines).toEqual([])
    const outcome = decidePipelineTick(unverifiableWorld, running)
    expect(outcome.action).toBeNull()
    expect('deviation' in outcome).toBe(false)
  })
})

describe('native pipeline step identities', () => {
  it('binds Merge actions to each child source and base while keeping retries distinct', () => {
    const payload = pipelinePayload(`version: 1
id: merge-identity
name: Merge identity
defaults:
  retry: 1
nodes:
  - id: plan
    type: agent
    prompt: Plan the work
    outputs:
      tasks:
        type: taskList
  - id: work
    type: swarm
    after: [plan]
    from: $plan.outputs.tasks
    child:
      harness: codex
      prompt: Apply the task
  - id: merge
    type: merge
    after: [work]
    from: work
`)
    const tasks = [
      { id: 'alpha', title: 'Alpha', spec: 'Apply alpha' },
      { id: 'beta', title: 'Beta', spec: 'Apply beta' }
    ]
    const sourceFor = (childInstanceId: string, sha: string, base: string) => ({
      childInstanceId,
      workspacePath: `/workspace/${childInstanceId}`,
      sourceHead: sha,
      committedChildSha: sha,
      workspaceDigest: `digest-${childInstanceId}`,
      applicableBaseCommit: base,
      unmergedPaths: []
    })
    const sources = {
      'work[alpha]': sourceFor('work[alpha]', 'alpha-commit', 'base-before-alpha'),
      'work[beta]': sourceFor('work[beta]', 'beta-commit', 'base-before-beta')
    }
    const baseWorld = world({
      payload,
      facts: {
        ...world({ payload }).facts,
        outputs: [nodeOutputs('plan', 0, 0, { tasks })],
        swarmExpansions: [
          { swarmId: 'work', epoch: 0, tasks, warnings: [], baseCommit: 'base-root' }
        ]
      },
      mergeSources: sources
    })

    const planDispatch = actionFrom(decidePipelineTick(baseWorld, emptyLedger()))
    expect(decodedKey(planDispatch).instanceId).toBe('plan')
    let ledger = append(
      emptyLedger(),
      attemptEntry(planDispatch, 'settled', 1_999, { effect: 'landed', attemptId: 'plan-landed' })
    )
    const alphaDispatch = actionFrom(decidePipelineTick(baseWorld, ledger))
    expect(decodedKey(alphaDispatch).instanceId).toBe('work[alpha]')
    ledger = append(
      ledger,
      attemptEntry(alphaDispatch, 'settled', 2_000, { effect: 'landed', attemptId: 'alpha-done' })
    )
    const betaDispatch = actionFrom(decidePipelineTick(baseWorld, ledger))
    expect(decodedKey(betaDispatch).instanceId).toBe('work[beta]')
    ledger = append(
      ledger,
      attemptEntry(betaDispatch, 'settled', 2_001, { effect: 'landed', attemptId: 'beta-done' })
    )

    const alphaMerge = actionFrom(decidePipelineTick(baseWorld, ledger))
    expect(alphaMerge.kind).toBe('pipeline-merge-child')
    expect(alphaMerge.childInstanceId).toBe('work[alpha]')
    expect(alphaMerge.baseCommit).toBe('base-before-alpha')
    expect(decodedKey(alphaMerge)).toMatchObject({
      instanceId: 'merge',
      epoch: 0,
      attempt: 0,
      step: JSON.stringify(['work[alpha]', ['commit', 'alpha-commit'], 'base-before-alpha'])
    })

    ledger = append(
      ledger,
      attemptEntry(alphaMerge, 'settled', 2_002, {
        effect: 'not-landed',
        attemptId: 'alpha-merge-failed',
        reason: 'The merge could not be applied'
      })
    )
    const alphaRetry = actionFrom(decidePipelineTick(baseWorld, ledger))
    expect(alphaRetry.childInstanceId).toBe('work[alpha]')
    expect(decodedKey(alphaRetry)).toMatchObject({
      instanceId: 'merge',
      epoch: 0,
      attempt: 1,
      step: decodedKey(alphaMerge).step
    })
    expect(alphaRetry.evidenceKey).not.toBe(alphaMerge.evidenceKey)

    const afterAlphaApplied = world({
      ...baseWorld,
      facts: {
        ...baseWorld.facts,
        mergeProgress: [
          {
            mergeId: 'merge',
            epoch: 0,
            childInstanceId: 'work[alpha]',
            state: 'applied',
            commitSha: 'alpha-commit',
            appliedCommitSha: 'alpha-commit',
            conflict: null
          }
        ]
      }
    })
    const betaMerge = actionFrom(decidePipelineTick(afterAlphaApplied, ledger))
    expect(betaMerge.kind).toBe('pipeline-merge-child')
    expect(betaMerge.childInstanceId).toBe('work[beta]')
    expect(betaMerge.baseCommit).toBe('base-before-beta')
    expect(decodedKey(betaMerge)).toMatchObject({
      instanceId: 'merge',
      epoch: 0,
      attempt: 1,
      step: JSON.stringify(['work[beta]', ['commit', 'beta-commit'], 'base-before-beta'])
    })
    expect(betaMerge.evidenceKey).not.toBe(alphaRetry.evidenceKey)
  })

  it('binds Script evidence to the command environment that will be executed', () => {
    const documentPayload = pipelinePayload(`version: 1
id: script-identity
name: Script identity
inputs:
  task:
    type: text
nodes:
  - id: run
    type: script
    command: printf '%s' "$TASK"
    capability: check
    inputs:
      TASK: $run.inputs.task
`)
    const firstWorld = world({
      payload: { ...documentPayload, runInputs: { task: 'first input' } }
    })
    const secondWorld = world({
      payload: { ...documentPayload, runInputs: { task: 'second input' } }
    })
    const first = actionFrom(decidePipelineTick(firstWorld, emptyLedger()))
    const second = actionFrom(decidePipelineTick(secondWorld, emptyLedger()))

    expect(first.kind).toBe('pipeline-run-script')
    expect(second.kind).toBe('pipeline-run-script')
    expect(first.env).toEqual({ TASK: 'first input' })
    expect(second.env).toEqual({ TASK: 'second input' })
    expect(first.resolvedInputsDigest).not.toBe(second.resolvedInputsDigest)
    expect(decodedKey(first)).toMatchObject({ instanceId: 'run', epoch: 0, attempt: 0 })
    expect(decodedKey(first).step).toMatch(/^script:/u)
    expect(first.evidenceKey).not.toBe(second.evidenceKey)
  })
})
