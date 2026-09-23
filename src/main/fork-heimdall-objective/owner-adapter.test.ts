import { describe, expect, it } from 'vitest'
import { createReportValidationProvenance } from '../../shared/fork-heimdall/effect-certainty'
import { OWNER_INTERVENTION_TEXT_MAX_LENGTH } from '../../shared/fork-heimdall/owner/intervention'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import {
  attempt,
  CONTRACT,
  ledger,
  node,
  projection,
  revision,
  snapshot
} from '../../shared/fork-heimdall-objective/decision-test-harness'
import {
  ObjectiveActionSchema,
  type ObjectiveAction
} from '../../shared/fork-heimdall-objective/objective-actions'
import { ObjectiveOwnerInterventionSchema } from '../../shared/fork-heimdall-objective/owner-intervention'
import { objectiveRejectIntervention } from './owner-adapter'
import { objectiveActionForIntervention } from './owner-adapter-actions'

const enrollment = {} as unknown as WatcherEnrollment

function rejectedIngestReport(reportedFiles: string[], observedFiles: string[], reason: string) {
  const action: ObjectiveAction = {
    kind: 'ingest-report',
    capability: 'implement',
    visibility: 'local',
    recovery: 'replay-safe',
    contentIdentity: 'content-current',
    evidenceKey: 'dispatch-core',
    revisionId: 'revision-1',
    dispatchId: 'dispatch-core',
    taskKey: 'core',
    orchestrationTaskId: 'task-dispatch-core',
    reportPath: '/outside/report.json',
    filesModified: reportedFiles,
    dispatchedContentIdentity: 'content-current'
  }
  return {
    ...attempt(action, { state: 'settled', effect: 'not-landed', reason }),
    result: {
      reportDigest: 'rejected-report-digest',
      reportedFiles,
      observedFiles,
      reportValidation: createReportValidationProvenance({
        status: 'rejected',
        code: 'workspace-invalid',
        role: 'implementer',
        dispatchId: 'dispatch-core',
        taskKey: 'core',
        reportPath: '/outside/report.json',
        detail: reason,
        reportedFiles,
        observedFiles,
        hostVerifiable: true
      })
    }
  }
}

describe('objectiveRejectIntervention: gate 1, write territory', () => {
  it('refuses accept-report when the rejected report touched a path outside write territory', () => {
    const rejected = rejectedIngestReport(
      ['src/core.ts'],
      ['src/core.ts', 'docs/leak.md'],
      'observed-change-outside-write-territory:docs/leak.md'
    )
    const rejection = objectiveRejectIntervention(
      {
        kind: 'accept-report',
        dispatchId: 'dispatch-core',
        taskKey: 'core',
        attestation: 'benign'
      },
      snapshot(projection()),
      ledger([rejected]),
      enrollment
    )
    expect(rejection).toMatchObject({ gate: 'write-territory' })
    expect(rejection?.reason).toContain('docs/leak.md')
  })

  it('allows accept-report when the mismatch stays within write territory', () => {
    const rejected = rejectedIngestReport(
      ['src/core.ts'],
      ['src/core.ts', 'src/extra.ts'],
      'reported-files-do-not-match-observed-changes'
    )
    const rejection = objectiveRejectIntervention(
      {
        kind: 'accept-report',
        dispatchId: 'dispatch-core',
        taskKey: 'core',
        attestation: 'benign'
      },
      snapshot(projection()),
      ledger([rejected]),
      enrollment
    )
    expect(rejection).toBeNull()
  })
})

describe('objectiveRejectIntervention: gate 2, landing bar', () => {
  it('refuses skip-stage for the stage the files-on-disk bar mandates', () => {
    const rejection = objectiveRejectIntervention(
      { kind: 'skip-stage', stage: 'files-on-disk', rationale: 'flaky check' },
      snapshot(projection()),
      ledger(),
      enrollment
    )
    expect(rejection).toMatchObject({ gate: 'landing-bar' })
  })

  it('allows skip-stage for a rung the files-on-disk bar never requires', () => {
    const rejection = objectiveRejectIntervention(
      { kind: 'skip-stage', stage: 'hosted-review', rationale: 'not required by this bar' },
      snapshot(projection()),
      ledger(),
      enrollment
    )
    expect(rejection).toBeNull()
  })

  it.each(['reviewer', 'integrator', 'checks'])(
    'allows skip-stage for "%s" on a hosted-review bar, since the bar never mandates it',
    (stage) => {
      const rejection = objectiveRejectIntervention(
        {
          kind: 'skip-stage',
          stage,
          criterionId: stage === 'checks' ? 'criterion-1' : undefined,
          rationale: 'the landing bar has no opinion on this stage'
        },
        snapshot(projection(), { contract: { ...CONTRACT, landingBar: 'hosted-review' } }),
        ledger(),
        enrollment
      )
      expect(rejection).toBeNull()
    }
  )
})

describe('objectiveActionForIntervention: skip-stage', () => {
  it('translates a reviewer skip into a synthetic approve verdict action', () => {
    const plan = projection({ nodes: [node('core', { state: 'succeeded' })] })
    const action = objectiveActionForIntervention(
      {
        kind: 'skip-stage',
        stage: 'reviewer',
        rationale: 'The bar does not require a reviewer verdict.'
      },
      snapshot(plan)
    )
    expect(action).toMatchObject({
      kind: 'skip-review',
      revisionId: 'revision-1',
      role: 'reviewer',
      reviewedContentIdentity: 'content-current',
      rationale: 'The bar does not require a reviewer verdict.'
    })
  })

  it('translates a checks skip naming a criterion into a synthetic passing check action', () => {
    const action = objectiveActionForIntervention(
      {
        kind: 'skip-stage',
        stage: 'checks',
        criterionId: 'criterion-1',
        rationale: 'Flaky in CI.'
      },
      snapshot(projection())
    )
    expect(action).toMatchObject({
      kind: 'skip-check',
      criterionId: 'criterion-1',
      rationale: 'Flaky in CI.'
    })
  })

  it('falls back to owner-directed planner guidance for a landing-ladder rung', () => {
    const action = objectiveActionForIntervention(
      { kind: 'skip-stage', stage: 'hosted-review', rationale: 'not required by this bar' },
      snapshot(projection())
    )
    expect(action).toMatchObject({ kind: 'dispatch-planner', reason: 'owner-directed' })
  })

  it('carries a maximum-length landing-stage rationale into planner guidance without expansion', () => {
    const rationale = 'r'.repeat(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
    const intervention = ObjectiveOwnerInterventionSchema.parse({
      kind: 'skip-stage',
      stage: 'hosted-review',
      rationale
    })
    const action = ObjectiveActionSchema.parse(
      objectiveActionForIntervention(intervention, snapshot(projection()))
    )
    expect(action).toMatchObject({
      kind: 'dispatch-planner',
      reason: 'owner-directed',
      requestedSkipStage: 'hosted-review',
      guidance: rationale
    })
  })
})

describe('objectiveActionForIntervention: owner-directed planner shape', () => {
  it('emits a full-shaped dispatch when no revision is approved yet', () => {
    const plan = projection({ revisions: [revision({ status: 'draft' })] })
    const action = objectiveActionForIntervention(
      { kind: 'dispatch-planner', guidance: 'Steer the plan.' },
      snapshot(plan),
      ledger()
    )
    expect(action).toMatchObject({ kind: 'dispatch-planner', guidance: 'Steer the plan.' })
    expect('shape' in action).toBe(false)
  })

  it('emits a repair-shaped dispatch targeting the approved revision when one exists', () => {
    const action = objectiveActionForIntervention(
      { kind: 'dispatch-planner', guidance: 'Steer the plan.' },
      snapshot(projection()),
      ledger()
    )
    expect(action).toMatchObject({
      kind: 'dispatch-planner',
      shape: 'repair',
      repairRevisionId: 'revision-1',
      repairOrdinal: 1
    })
  })

  it('numbers the repair ordinal past the highest one already claimed for the revision', () => {
    const priorRepair: ObjectiveAction = {
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: 'content-prior',
      evidenceKey: 'plan:2:owner-directed:content-prior',
      revisionNumber: 2,
      reason: 'owner-directed',
      shape: 'repair',
      repairOrdinal: 2,
      repairRevisionId: 'revision-1'
    }
    const action = objectiveActionForIntervention(
      { kind: 'dispatch-planner', guidance: 'Steer the plan again.' },
      snapshot(projection()),
      ledger([attempt(priorRepair)])
    )
    expect(action).toMatchObject({
      shape: 'repair',
      repairRevisionId: 'revision-1',
      repairOrdinal: 3
    })
  })
})

describe('objectiveActionForIntervention: retry-node', () => {
  it('produces a retry pinned to the original dispatch evidenceKey with owner overrides', () => {
    const plan = projection({ nodes: [node('core', { state: 'failed' })] })
    const action = objectiveActionForIntervention(
      { kind: 'retry-node', taskKey: 'core', amendedSpec: 'Fixed spec', agent: 'sonnet' },
      snapshot(plan)
    )
    expect(action).toMatchObject({
      kind: 'dispatch-node',
      revisionId: 'revision-1',
      taskKey: 'core',
      retryOf: 'revision-1:core',
      ownerAmendedSpec: 'Fixed spec',
      ownerAgent: 'sonnet'
    })
  })

  it('rebuilds depsOrchestrationIds from sibling node state instead of the ledger', () => {
    const plan = projection({
      nodes: [
        node('base', {
          state: 'succeeded',
          orchestrationTaskId: 'orchestration-base'
        }),
        node('core', { deps: ['base'], state: 'failed' })
      ]
    })
    const action = objectiveActionForIntervention(
      { kind: 'retry-node', taskKey: 'core' },
      snapshot(plan)
    )
    expect(action).toMatchObject({
      kind: 'dispatch-node',
      depsOrchestrationIds: ['orchestration-base']
    })
  })
})

describe('objectiveActionForIntervention: amend-plan', () => {
  it('passes the patch through to ObjectiveStoreMutations.amendRevision verbatim', () => {
    const patch = {
      digest: 'amend-digest-1',
      attestation: 'store-facing rationale',
      upsertTasks: [],
      dropTaskKeys: ['core']
    }
    const action = objectiveActionForIntervention(
      {
        kind: 'amend-plan',
        revisionId: 'revision-1',
        patch,
        attestation: 'owner-facing rationale'
      },
      snapshot(projection())
    )
    expect(action).toMatchObject({
      kind: 'amend-plan',
      revisionId: 'revision-1',
      patch,
      attestation: 'owner-facing rationale'
    })
  })
})
