import { afterEach, describe, expect, it, vi } from 'vitest'
import { approvalScopeForAction } from '../../shared/fork-heimdall/gate'
import { getLatestEscalations } from '../../shared/fork-heimdall/ledger-queries'
import type { EscalationEntry } from '../../shared/fork-heimdall/ledger-types'
import type { KernelAction } from '../../shared/fork-heimdall/kind-contract'
import {
  makePipelineNodeEvidenceKey,
  PIPELINE_ANSWER_EVIDENCE_KIND,
  type PipelineChoiceCause
} from '../../shared/fork-heimdall-pipeline/choice-types'
import { PipelineEnrollmentPayloadSchema } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import { bindHeimdallPipeline } from '../fork-heimdall-pipeline/pipeline-binding'
import { PipelineDatabase } from '../fork-heimdall-pipeline/pipeline-database'
import { pipelineEnrollmentInput } from '../fork-heimdall-pipeline/pipeline-kind-test-harness'
import { PipelineStore } from '../fork-heimdall-pipeline/pipeline-store'
import { action, enrollmentInput, harness, kind } from './kernel-service-test-harness'

vi.mock('electron', () => ({}))

const pipelineDatabases: PipelineDatabase[] = []

afterEach(() => {
  for (const database of pipelineDatabases.splice(0)) {
    database.close()
  }
})

const FIRST_ATTRIBUTION = {
  actor: { user: 'alice', host: 'laptop' },
  surface: 'cli',
  atMs: 42
} as const

const SECOND_ATTRIBUTION = {
  actor: { user: 'bob', host: 'desktop' },
  surface: 'canvas-run',
  atMs: 43
} as const

function pipelinePayload(gateSendBackTo?: string) {
  const sourceText = `version: 1
id: bugfix
name: Bugfix (fast)
inputs:
  task:
    type: text
    required: true
nodes:
  - id: fix
    type: agent
    label: Fix
    harness: claude
    prompt: Fix it
  - id: approve
    type: gate
    label: Approve plan
${gateSendBackTo === undefined ? '' : `    sendBackTo: ${gateSendBackTo}\n`}`
  return PipelineEnrollmentPayloadSchema.parse(
    pipelineEnrollmentInput(
      { repoId: 'repo-1', worktreeId: 'worktree-1', workspaceKind: 'git' },
      sourceText
    ).kindPayload
  )
}

function pipelineChoiceAction(input: {
  contentHash: string
  actionKind?: 'pipeline-pass-gate' | 'pipeline-apply-choice'
  instanceId?: string
  cause?: PipelineChoiceCause
}): KernelAction {
  const cause = input.cause ?? 'gate'
  return {
    kind: input.actionKind ?? 'pipeline-pass-gate',
    capability: 'gate',
    visibility: 'local',
    contentIdentity: `pipeline:${input.contentHash}`,
    evidenceKey: makePipelineNodeEvidenceKey({
      instanceId: input.instanceId ?? 'approve',
      epoch: 0,
      attempt: 1,
      cause,
      ...(cause === 'time-limit' ? { deadlineMs: 1_000 } : {})
    }),
    approvalRequired: true
  }
}

async function pipelineWatcher(
  options: {
    actionKind?: 'pipeline-pass-gate' | 'pipeline-apply-choice'
    instanceId?: string
    cause?: PipelineChoiceCause
    gateSendBackTo?: string
  } = {}
) {
  const state = await harness()
  const pipelineDatabase = new PipelineDatabase(':memory:')
  pipelineDatabases.push(pipelineDatabase)
  const pipelineStore = new PipelineStore(pipelineDatabase)
  bindHeimdallPipeline(state.runtime, { store: state.store, pipelineStore })
  const payload = pipelinePayload(options.gateSendBackTo)
  const pendingAction = pipelineChoiceAction({
    ...options,
    contentHash: payload.pin.contentHash
  })
  state.service.registerKind({
    ...kind({
      id: 'pipeline',
      read: async () => ({
        freshness: 'live',
        contentIdentity: pendingAction.contentIdentity,
        observedAtMs: 1,
        world: { revision: 'revision-1' }
      }),
      decide: () => ({ action: pendingAction })
    }),
    enrollmentPayloadSchema: PipelineEnrollmentPayloadSchema
  })
  const enrolled = await state.service.enroll({
    ...enrollmentInput(),
    kind: 'pipeline',
    capabilities: { gate: 'on' },
    kindPayload: payload
  })
  if (enrolled.status !== 'enrolled') {
    throw new Error('expected pipeline enrollment')
  }
  const watcherId = enrolled.entry.enrollment.watcherId
  await state.service.reconcileForTesting(watcherId)
  return {
    ...state,
    watcherId,
    pendingAction,
    scope: approvalScopeForAction(pendingAction)
  }
}

describe('Heimdall approval control', () => {
  it('appends resolved revisions only for exact matching approval escalations and permits the action', async () => {
    const approvedAction = {
      ...action('revision-1'),
      preparedCommitSha: 'prepared-1'
    }
    const execute = vi.fn(async () => ({ effect: 'landed' as const }))
    const { service, ledgerStore } = await harness()
    service.registerKind(
      kind({
        decide: () => ({ action: approvedAction }),
        execute
      })
    )
    const enrolled = await service.enroll({
      ...enrollmentInput(),
      capabilities: { write: 'gated' }
    })
    if (enrolled.status !== 'enrolled') {
      throw new Error('expected enrollment')
    }
    const watcherId = enrolled.entry.enrollment.watcherId
    await service.reconcileForTesting(watcherId)

    const scope = approvalScopeForAction(approvedAction)
    const originalOpen = getLatestEscalations(service.ledger(watcherId)).find(
      (entry) => entry.escalationKind === 'awaiting-approval'
    )
    if (!originalOpen) {
      throw new Error('expected an awaiting-approval escalation')
    }
    const appendEscalation = (
      entry: Omit<EscalationEntry, 'watcherId' | 'origin' | 'class' | 'kind'>
    ) =>
      ledgerStore.append({
        watcherId,
        origin: 'owner',
        class: 'fact',
        kind: 'escalation',
        ...entry
      })
    appendEscalation({
      eventId: 'matching-escalated',
      atMs: 20,
      escalationId: 'matching-escalated',
      escalationKind: 'awaiting-approval',
      status: 'escalated',
      foldCount: 4,
      approvalScope: scope
    })
    appendEscalation({
      eventId: 'newer-prepared-commit',
      atMs: 21,
      escalationId: 'newer-prepared-commit',
      escalationKind: 'awaiting-approval',
      status: 'open',
      foldCount: 2,
      approvalScope: { ...scope, preparedCommitSha: 'prepared-2' }
    })
    appendEscalation({
      eventId: 'other-kind',
      atMs: 22,
      escalationId: 'other-kind',
      escalationKind: 'worker-question',
      status: 'open',
      foldCount: 3,
      approvalScope: scope
    })

    const before = service.ledger(watcherId)
    const row = (await service.fleet()).entries[0]!
    await expect(
      service.command({
        target: row.target,
        expectedOwner: row.ownerFence,
        command: { kind: 'approve', scope }
      })
    ).resolves.toMatchObject({ status: 'applied' })

    const after = service.ledger(watcherId)
    expect(after.entries).toHaveLength(before.entries.length + 3)
    expect(after.entries.slice(0, before.entries.length)).toEqual(before.entries)
    expect(after.entries.slice(before.entries.length)).toEqual([
      expect.objectContaining({ kind: 'approval', scope, decision: 'approved' }),
      expect.objectContaining({
        kind: 'escalation',
        escalationId: originalOpen.escalationId,
        status: 'resolved',
        foldCount: originalOpen.foldCount + 1,
        approvalScope: scope
      }),
      expect.objectContaining({
        kind: 'escalation',
        escalationId: 'matching-escalated',
        status: 'resolved',
        foldCount: 5,
        approvalScope: scope
      })
    ])
    const latest = getLatestEscalations(after)
    expect(latest.find((entry) => entry.escalationId === 'newer-prepared-commit')).toMatchObject({
      status: 'open',
      foldCount: 2
    })
    expect(latest.find((entry) => entry.escalationId === 'other-kind')).toMatchObject({
      status: 'open',
      foldCount: 3
    })

    await service.reconcileForTesting(watcherId)
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('records an attributed choice atomically and returns the first answer attribution', async () => {
    const state = await pipelineWatcher()
    const row = (await state.service.fleet()).entries[0]!
    const before = state.service.ledger(state.watcherId)

    await expect(
      state.service.command({
        target: row.target,
        expectedOwner: row.ownerFence,
        command: {
          kind: 'answer-pipeline-choice',
          scope: state.scope,
          choice: 'approve',
          attribution: FIRST_ATTRIBUTION
        }
      })
    ).resolves.toMatchObject({ status: 'applied' })

    const after = state.service.ledger(state.watcherId)
    const appended = after.entries.slice(before.entries.length)
    expect(appended.map((entry) => entry.kind)).toEqual(['approval', 'evidence', 'escalation'])
    const approvalEntry = appended[0]
    const answerEntry = appended[1]
    if (approvalEntry?.kind !== 'approval' || answerEntry?.kind !== 'evidence') {
      throw new Error('expected an approval followed by answer evidence')
    }
    expect(approvalEntry).toMatchObject({
      scope: state.scope,
      decision: 'approved',
      foldCount: 1
    })
    expect(answerEntry).toMatchObject({
      evidenceKind: PIPELINE_ANSWER_EVIDENCE_KIND,
      payload: {
        approvalEventId: approvalEntry.eventId,
        scope: state.scope,
        choice: 'approve',
        attribution: FIRST_ATTRIBUTION
      }
    })
    expect(
      getLatestEscalations(after).find(
        (entry) => entry.approvalScope?.evidenceKey === state.scope.evidenceKey
      )
    ).toMatchObject({ status: 'resolved', approvalScope: state.scope })

    const current = (await state.service.fleet()).entries[0]!
    const beforeSecondAnswer = state.service.ledger(state.watcherId)
    await expect(
      state.service.command({
        target: current.target,
        expectedOwner: current.ownerFence,
        command: {
          kind: 'answer-pipeline-choice',
          scope: state.scope,
          choice: 'abort',
          attribution: SECOND_ATTRIBUTION
        }
      })
    ).resolves.toMatchObject({
      status: 'refused',
      reason: 'already-resolved',
      resolvedBy: FIRST_ATTRIBUTION
    })
    expect(state.service.ledger(state.watcherId)).toEqual(beforeSecondAnswer)
  })

  it('rolls back approval and answer evidence when the evidence append throws', async () => {
    const state = await pipelineWatcher()
    const row = (await state.service.fleet()).entries[0]!
    const before = state.service.ledger(state.watcherId)
    const append = state.ledgerStore.append.bind(state.ledgerStore)
    vi.spyOn(state.ledgerStore, 'append').mockImplementation((entry) => {
      const appendResult = append(entry)
      if (entry.kind === 'evidence' && entry.evidenceKind === PIPELINE_ANSWER_EVIDENCE_KIND) {
        throw new Error('injected answer evidence failure')
      }
      return appendResult
    })

    await expect(
      state.service.command({
        target: row.target,
        expectedOwner: row.ownerFence,
        command: {
          kind: 'answer-pipeline-choice',
          scope: state.scope,
          choice: 'approve',
          attribution: FIRST_ATTRIBUTION
        }
      })
    ).resolves.toMatchObject({
      status: 'indeterminate',
      detail: 'injected answer evidence failure'
    })
    expect(state.service.ledger(state.watcherId)).toEqual(before)
  })

  it('refuses legacy approve for pipeline scopes without writing unattributed resolution', async () => {
    const state = await pipelineWatcher()
    const row = (await state.service.fleet()).entries[0]!
    const before = state.service.ledger(state.watcherId)

    await expect(
      state.service.command({
        target: row.target,
        expectedOwner: row.ownerFence,
        command: { kind: 'approve', scope: state.scope }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'invalid-command' })
    expect(state.service.ledger(state.watcherId)).toEqual(before)
    expect(
      getLatestEscalations(state.service.ledger(state.watcherId)).find(
        (entry) => entry.approvalScope?.evidenceKey === state.scope.evidenceKey
      )
    ).toMatchObject({ status: 'open' })
  })

  it('refuses legacy approve for pipeline apply-choice scopes', async () => {
    const state = await pipelineWatcher({
      actionKind: 'pipeline-apply-choice',
      instanceId: 'fix',
      cause: 'retries-exhausted'
    })
    const row = (await state.service.fleet()).entries[0]!
    const before = state.service.ledger(state.watcherId)

    await expect(
      state.service.command({
        target: row.target,
        expectedOwner: row.ownerFence,
        command: { kind: 'approve', scope: state.scope }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'invalid-command' })
    expect(state.service.ledger(state.watcherId)).toEqual(before)
  })

  it('refuses a pipeline answer while the watcher is paused', async () => {
    const state = await pipelineWatcher()
    const initial = (await state.service.fleet()).entries[0]!
    await expect(
      state.service.command({
        target: initial.target,
        expectedOwner: initial.ownerFence,
        command: { kind: 'pause' }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    const row = (await state.service.fleet()).entries[0]!
    const before = state.service.ledger(state.watcherId)

    await expect(
      state.service.command({
        target: row.target,
        expectedOwner: row.ownerFence,
        command: {
          kind: 'answer-pipeline-choice',
          scope: state.scope,
          choice: 'approve',
          attribution: FIRST_ATTRIBUTION
        }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'invalid-state' })
    expect(state.service.ledger(state.watcherId)).toEqual(before)
  })

  it('validates pending options and required send-back and extend details', async () => {
    const unavailable = await pipelineWatcher()
    const unavailableRow = (await unavailable.service.fleet()).entries[0]!
    await expect(
      unavailable.service.command({
        target: unavailableRow.target,
        expectedOwner: unavailableRow.ownerFence,
        command: {
          kind: 'answer-pipeline-choice',
          scope: unavailable.scope,
          choice: 'send-back',
          comment: 'Fix this first',
          attribution: FIRST_ATTRIBUTION
        }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'invalid-command' })

    const changedAttemptScope = {
      ...unavailable.scope,
      evidenceKey: makePipelineNodeEvidenceKey({
        instanceId: 'approve',
        epoch: 1,
        attempt: 1,
        cause: 'gate'
      })
    }
    await expect(
      unavailable.service.command({
        target: unavailableRow.target,
        expectedOwner: unavailableRow.ownerFence,
        command: {
          kind: 'answer-pipeline-choice',
          scope: changedAttemptScope,
          choice: 'approve',
          attribution: FIRST_ATTRIBUTION
        }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'invalid-state' })

    const sendBack = await pipelineWatcher({ gateSendBackTo: 'fix' })
    const sendBackRow = (await sendBack.service.fleet()).entries[0]!
    await expect(
      sendBack.service.command({
        target: sendBackRow.target,
        expectedOwner: sendBackRow.ownerFence,
        command: {
          kind: 'answer-pipeline-choice',
          scope: sendBack.scope,
          choice: 'send-back',
          attribution: FIRST_ATTRIBUTION
        }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'invalid-command' })

    const extend = await pipelineWatcher({
      actionKind: 'pipeline-apply-choice',
      instanceId: 'fix',
      cause: 'time-limit'
    })
    const extendRow = (await extend.service.fleet()).entries[0]!
    await expect(
      extend.service.command({
        target: extendRow.target,
        expectedOwner: extendRow.ownerFence,
        command: {
          kind: 'answer-pipeline-choice',
          scope: extend.scope,
          choice: 'extend',
          attribution: FIRST_ATTRIBUTION
        }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'invalid-command' })
  })

  it('rejects extendMinutes on another choice without consuming the pending approval', async () => {
    const state = await pipelineWatcher()
    const row = (await state.service.fleet()).entries[0]!
    const before = state.service.ledger(state.watcherId)

    await expect(
      state.service.command({
        target: row.target,
        expectedOwner: row.ownerFence,
        command: {
          kind: 'answer-pipeline-choice',
          scope: state.scope,
          choice: 'approve',
          extendMinutes: 30,
          attribution: FIRST_ATTRIBUTION
        }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'invalid-command' })
    expect(state.service.ledger(state.watcherId)).toEqual(before)

    await expect(
      state.service.command({
        target: row.target,
        expectedOwner: row.ownerFence,
        command: {
          kind: 'answer-pipeline-choice',
          scope: state.scope,
          choice: 'approve',
          attribution: FIRST_ATTRIBUTION
        }
      })
    ).resolves.toMatchObject({ status: 'applied' })
    expect(
      state.service.ledger(state.watcherId).entries.slice(before.entries.length)
    ).toMatchObject([
      { kind: 'approval', decision: 'approved' },
      { kind: 'evidence', evidenceKind: PIPELINE_ANSWER_EVIDENCE_KIND },
      { kind: 'escalation', status: 'resolved' }
    ])
  })

  it('refuses an answer without attribution without resolving its pending approval', async () => {
    const state = await pipelineWatcher()
    const row = (await state.service.fleet()).entries[0]!
    const before = state.service.ledger(state.watcherId)

    await expect(
      state.service.command({
        target: row.target,
        expectedOwner: row.ownerFence,
        command: {
          kind: 'answer-pipeline-choice',
          scope: state.scope,
          choice: 'approve'
        }
      })
    ).resolves.toMatchObject({ status: 'refused', reason: 'invalid-command' })
    expect(state.service.ledger(state.watcherId)).toEqual(before)
  })
})
