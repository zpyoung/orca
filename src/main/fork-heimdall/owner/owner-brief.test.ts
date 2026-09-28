import { describe, expect, it } from 'vitest'
import type { KernelAction, OwnerAdapter } from '../../../shared/fork-heimdall/kind-contract'
import type { LedgerEntry, WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { Deviation } from '../../../shared/fork-heimdall/owner/deviation'
import { InterventionSchema } from '../../../shared/fork-heimdall/owner/intervention'
import type { Snapshot } from '../../../shared/fork-heimdall/snapshot'
import { buildOwnerBrief, buildOwnerPromptText, expandOwnerBrief } from './owner-brief'

type World = { revision: string }

const snapshot: Snapshot<World> = {
  freshness: 'live',
  contentIdentity: 'revision-1',
  observedAtMs: 1,
  world: { revision: 'revision-1' }
}

const deviation: Deviation = {
  kind: 'worker-question',
  messageId: 'message-1',
  dispatchId: 'trigger-dispatch',
  question: 'Which branch?'
}

function ledger(entries: LedgerEntry[] = []): WatcherLedger {
  return { watcherId: 'watcher-1', entries }
}

function owner(
  describeState: OwnerAdapter<World, KernelAction>['describeState']
): OwnerAdapter<World, KernelAction> {
  return {
    describeState,
    describeInterventions: () => 'kind-specific',
    interventionSchema: InterventionSchema,
    rejectIntervention: () => null,
    actionForIntervention: () => ({
      kind: 'continue',
      capability: 'read',
      visibility: 'local',
      contentIdentity: 'revision-1',
      evidenceKey: 'continue:revision-1'
    })
  }
}

function attempt(args: {
  attemptId: string
  evidenceKey: string
  dispatchId: string
  atMs: number
  state: 'running' | 'settled'
  reason: string
}): LedgerEntry {
  return {
    eventId: `event:${args.attemptId}`,
    watcherId: 'watcher-1',
    atMs: args.atMs,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: args.attemptId,
    fingerprint: `fingerprint:${args.attemptId}`,
    action: {
      kind: 'dispatch-node',
      capability: 'write',
      visibility: 'local',
      contentIdentity: 'revision-1',
      evidenceKey: args.evidenceKey
    },
    state: args.state,
    ...(args.state === 'settled' ? { effect: 'landed' as const } : {}),
    reason: args.reason,
    dispatchId: args.dispatchId
  }
}

describe('buildOwnerBrief state budget', () => {
  it('accounts for the normalized envelope instead of giving the whole budget to kind state', () => {
    const requestedBudgets: number[] = []
    const brief = buildOwnerBrief({
      contentIdentity: snapshot.contentIdentity,
      snapshot,
      ledger: ledger(),
      deviation,
      owner: owner((_snapshot, _ledger, maxBytes) => {
        requestedBudgets.push(maxBytes)
        return {
          text: JSON.stringify({ payload: 'x'.repeat(Math.max(0, maxBytes - 32)) }),
          truncated: maxBytes < 8_000
        }
      }),
      maxStateBytes: 4_096
    })

    expect(brief.fitsStateBudget).toBe(true)
    expect(brief.serializedBytes).toBeLessThanOrEqual(4_096)
    expect(requestedBudgets).toContain(4_096)
    expect(requestedBudgets.some((budget) => budget < 4_096)).toBe(true)
  })

  it('omits only the chronologically oldest completed attempt and exposes its canonical reference', () => {
    const entries: LedgerEntry[] = [
      attempt({
        attemptId: 'oldest',
        evidenceKey: 'z-oldest',
        dispatchId: 'oldest-dispatch',
        atMs: 10,
        state: 'settled',
        reason: `oldest:${'a'.repeat(3_000)}`
      }),
      attempt({
        attemptId: 'newer',
        evidenceKey: 'a-newer',
        dispatchId: 'newer-dispatch',
        atMs: 20,
        state: 'settled',
        reason: `newer:${'b'.repeat(3_000)}`
      }),
      attempt({
        attemptId: 'trigger',
        evidenceKey: 'trigger',
        dispatchId: 'trigger-dispatch',
        atMs: 30,
        state: 'running',
        reason: 'still running'
      }),
      {
        eventId: 'worker-done-trigger',
        watcherId: 'watcher-1',
        atMs: 31,
        origin: 'owner',
        class: 'fact',
        kind: 'evidence',
        evidenceKind: 'orchestration-mailbox',
        payload: {
          type: 'worker_done',
          subject: 'trigger report',
          body: 'submitted',
          payload: { dispatchId: 'trigger-dispatch', summary: 'canonical trigger evidence' }
        }
      }
    ]
    const adapter = owner(() => ({ text: '{"current":true}', truncated: false }))
    const full = buildOwnerBrief({
      contentIdentity: snapshot.contentIdentity,
      snapshot,
      ledger: ledger(entries),
      deviation,
      owner: adapter
    })
    const bounded = buildOwnerBrief({
      contentIdentity: snapshot.contentIdentity,
      snapshot,
      ledger: ledger(entries),
      deviation,
      owner: adapter,
      maxStateBytes: full.serializedBytes - 500
    })
    const state = expandOwnerBrief(bounded.state)

    expect(bounded.fitsStateBudget).toBe(true)
    expect(state.truncation).toMatchObject({
      omitted: { completedAttempts: 1 },
      references: {
        completedAttempts: {
          source: 'watcher-ledger.entries[kind=attempt]',
          digest: expect.stringMatching(/^sha256:/)
        }
      }
    })
    expect(JSON.stringify(state.recentAttempts)).not.toContain('oldest:')
    expect(JSON.stringify(state.recentAttempts)).toContain('newer:')
    expect(JSON.stringify(state.recentAttempts)).toContain('still running')
    expect(state.triggeringReport).toMatchObject({
      payload: { dispatchId: 'trigger-dispatch', summary: 'canonical trigger evidence' }
    })
  })

  it('bounds a previous rejection with an explicit omitted-unit reference', () => {
    const rejection = `invalid rationale: ${'界'.repeat(5_000)}`
    const brief = buildOwnerBrief({
      contentIdentity: snapshot.contentIdentity,
      snapshot,
      ledger: ledger(),
      deviation,
      owner: owner(() => ({ text: '{"current":true}', truncated: false })),
      previousSubmissionRejection: rejection
    })
    const previous = expandOwnerBrief(brief.state).previousSubmissionRejection

    expect(brief.fitsStateBudget).toBe(true)
    expect(previous).toMatchObject({
      omittedCodeUnits: rejection.length - 4_096,
      reference: 'previous rejected owner submission diagnostic'
    })
    expect(previous?.reason.length).toBe(4_096)
    expect(rejection.startsWith(previous?.reason ?? '')).toBe(true)
  })

  it('bounds a supplied operator answer and omits the field when none was given', () => {
    const withAnswer = buildOwnerBrief({
      contentIdentity: snapshot.contentIdentity,
      snapshot,
      ledger: ledger(),
      deviation,
      owner: owner(() => ({ text: '{"current":true}', truncated: false })),
      operatorAnswer: 'Use main.'
    })
    const withoutAnswer = buildOwnerBrief({
      contentIdentity: snapshot.contentIdentity,
      snapshot,
      ledger: ledger(),
      deviation,
      owner: owner(() => ({ text: '{"current":true}', truncated: false }))
    })

    expect(expandOwnerBrief(withAnswer.state).operatorAnswer).toMatchObject({
      body: 'Use main.',
      reference: 'operator reply to the owner escalation'
    })
    expect(expandOwnerBrief(withoutAnswer.state).operatorAnswer).toBeUndefined()
  })
})

describe('buildOwnerPromptText operator answer section', () => {
  it('renders an OPERATOR ANSWER section only when the brief carries one', () => {
    const withAnswer = buildOwnerBrief({
      contentIdentity: snapshot.contentIdentity,
      snapshot,
      ledger: ledger(),
      deviation,
      owner: owner(() => ({ text: '{"current":true}', truncated: false })),
      operatorAnswer: 'Use main.'
    })
    const withoutAnswer = buildOwnerBrief({
      contentIdentity: snapshot.contentIdentity,
      snapshot,
      ledger: ledger(),
      deviation,
      owner: owner(() => ({ text: '{"current":true}', truncated: false }))
    })

    const promptWithAnswer = buildOwnerPromptText({
      watcherId: 'watcher-1',
      wakeToken: 'wake-1',
      runId: 'run-1',
      interventionVocabulary: 'kind-specific',
      reportPath: '/tmp/report.json',
      brief: withAnswer
    })
    const promptWithoutAnswer = buildOwnerPromptText({
      watcherId: 'watcher-1',
      wakeToken: 'wake-1',
      runId: 'run-1',
      interventionVocabulary: 'kind-specific',
      reportPath: '/tmp/report.json',
      brief: withoutAnswer
    })

    expect(promptWithAnswer).toContain('OPERATOR ANSWER:\nUse main.')
    expect(promptWithoutAnswer).not.toContain('OPERATOR ANSWER')
  })
})
