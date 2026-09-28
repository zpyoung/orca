import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  KindAgnosticInterventionSchema,
  type Intervention
} from '../../../shared/fork-heimdall/owner/intervention'
import type {
  OwnerAdapter,
  OwnerInterventionRejection
} from '../../../shared/fork-heimdall/kind-contract'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import type { Snapshot } from '../../../shared/fork-heimdall/snapshot'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import { evaluateOwnerIntervention } from './owner-intervention'
import type { OwnerReportReadResult } from './owner-report-io'

type World = { revision: string }
type TestAction = {
  kind: 'apply-fix'
  capability: string
  visibility: 'local'
  contentIdentity: string
  evidenceKey: string
}

const acceptReportSchema = z
  .object({ kind: z.literal('accept-report'), filesModified: z.array(z.string()) })
  .strict()
const skipNodeSchema = z
  .object({
    kind: z.literal('skip-node'),
    taskKey: z.string(),
    rationale: z.string().trim().min(1).max(10)
  })
  .strict()
const KindInterventionSchema = z.discriminatedUnion('kind', [
  ...KindAgnosticInterventionSchema.options,
  acceptReportSchema,
  skipNodeSchema
])

function fakeOwner(rejection: OwnerInterventionRejection | null): OwnerAdapter<World, TestAction> {
  return {
    describeState: () => ({ text: 'state', truncated: false }),
    describeInterventions: () => 'accept-report',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a strict discriminated-union schema has no index signature, so it cannot structurally satisfy z.ZodType<Intervention>'s passthrough shape even though it validates the same fields at runtime.
    interventionSchema: KindInterventionSchema as unknown as z.ZodType<Intervention>,
    rejectIntervention: () => rejection,
    actionForIntervention: () => ({
      kind: 'apply-fix',
      capability: 'write',
      visibility: 'local',
      contentIdentity: 'revision-1',
      evidenceKey: 'apply-fix:revision-1'
    })
  }
}

const snapshot: Snapshot<World> = {
  freshness: 'live',
  contentIdentity: 'revision-1',
  observedAtMs: 1,
  world: { revision: 'revision-1' }
}
const ledger: WatcherLedger = { watcherId: 'watcher-1', entries: [] }
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fakeOwner's rejectIntervention/actionForIntervention ignore their enrollment argument, so it is never read by this suite.
const enrollment = {} as WatcherEnrollment

function readOk(report: unknown): OwnerReportReadResult<unknown> {
  return { ok: true, path: '/report.json', report }
}

describe('evaluateOwnerIntervention', () => {
  it('routes a kind-agnostic move without consulting the kind gates', () => {
    const outcome = evaluateOwnerIntervention({
      read: readOk({ kind: 'continue' }),
      owner: fakeOwner({ gate: 'write-territory', reason: 'should never be reached' }),
      snapshot,
      ledger,
      enrollment
    })
    expect(outcome).toEqual({ status: 'agnostic', move: { kind: 'continue' } })
  })

  it('propagates a read failure as malformed', () => {
    const outcome = evaluateOwnerIntervention({
      read: { ok: false, reason: 'missing' },
      owner: fakeOwner(null),
      snapshot,
      ledger,
      enrollment
    })
    expect(outcome.status).toBe('malformed')
  })

  it('rejects a kind-specific move that fails schema validation', () => {
    const outcome = evaluateOwnerIntervention({
      read: readOk({ kind: 'accept-report', filesModified: 'not-an-array' }),
      owner: fakeOwner(null),
      snapshot,
      ledger,
      enrollment
    })
    expect(outcome.status).toBe('malformed')
  })

  it('names UTF-16 units and marks the bounded over-cap text as a rejected preview', () => {
    const rationale = 'far too long for the cap'
    const outcome = evaluateOwnerIntervention({
      read: readOk({ kind: 'skip-node', taskKey: 'task-1', rationale }),
      owner: fakeOwner(null),
      snapshot,
      ledger,
      enrollment
    })
    if (outcome.status !== 'malformed') {
      throw new Error(`expected malformed, got ${outcome.status}`)
    }
    expect(outcome.reason).toBe(
      `rationale is ${rationale.length} JavaScript UTF-16 code units, over the 10-code-unit limit; previewed the first 10 code units (submission rejected, no correction applied): ${rationale.slice(0, 10)}`
    )
    expect(outcome.reason).not.toContain('too_big')
  })
})
