import { describe, expect, it } from 'vitest'
import { ObjectiveActionSchema, objectiveActionNaturalKey } from './objective-actions'

describe('objective action recovery contracts', () => {
  it('derives report and check natural keys entirely from persisted actions', () => {
    const report = ObjectiveActionSchema.parse({
      kind: 'ingest-report',
      capability: 'implement',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: 'dispatch-1',
      revisionId: 'revision-1',
      dispatchId: 'dispatch-1',
      taskKey: 'core',
      orchestrationTaskId: 'task-1',
      reportPath: '/outside/report.json',
      filesModified: ['src/core.ts'],
      dispatchedContentIdentity: 'content-before-worker'
    })
    expect(objectiveActionNaturalKey(report)).toEqual({
      kind: 'implementer-report',
      revisionId: 'revision-1',
      taskKey: 'core',
      dispatchId: 'dispatch-1'
    })

    const check = ObjectiveActionSchema.parse({
      kind: 'run-check',
      capability: 'check',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'criterion-1:content-current',
      criterionId: 'criterion-1',
      command: 'pnpm check'
    })
    expect(objectiveActionNaturalKey(check)).toEqual({
      kind: 'check-attempt',
      criterionId: 'criterion-1',
      contentIdentity: 'content-current'
    })
  })

  it('requires replay-safe on store ingestion and forbids it on checks', () => {
    const ingestion = {
      kind: 'ingest-plan',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'dispatch-plan',
      dispatchId: 'dispatch-plan',
      revisionNumber: 1,
      reportPath: '/outside/plan.json'
    }
    expect(ObjectiveActionSchema.safeParse(ingestion).success).toBe(false)
    expect(ObjectiveActionSchema.safeParse({ ...ingestion, recovery: 'replay-safe' }).success).toBe(
      true
    )

    const check = {
      kind: 'run-check',
      capability: 'check',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'criterion-1:content-current',
      criterionId: 'criterion-1',
      command: 'pnpm check'
    }
    expect(ObjectiveActionSchema.safeParse(check).success).toBe(true)
    expect(ObjectiveActionSchema.safeParse({ ...check, recovery: 'replay-safe' }).success).toBe(
      false
    )
  })
})
