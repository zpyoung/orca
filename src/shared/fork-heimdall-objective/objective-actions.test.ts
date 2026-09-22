import { describe, expect, it } from 'vitest'
import { OBJECTIVE_ABSENT_REMOTE_REF_STATE } from './contract-types'
import { ObjectiveActionResultSchema } from './objective-action-results'
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

describe('objective landing rung action contracts', () => {
  it('pins local replay while external rungs remain probe-only by omission', () => {
    const commit = ObjectiveActionSchema.parse({
      kind: 'commit-local-branch',
      capability: 'land',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-before',
      evidenceKey: 'committed-local-branch:content-before',
      rung: 'committed-local-branch',
      revisionId: 'revision-1',
      branch: 'feature/objective',
      headSha: 'head-before',
      worktreeContentDigest: 'worktree-digest',
      fromContentIdentity: 'content-before',
      attemptTrailer: 'committed-local-branch:content-before'
    })
    expect(objectiveActionNaturalKey(commit)).toEqual({
      kind: 'commit-local-branch',
      revisionId: 'revision-1',
      fromContentIdentity: 'content-before'
    })

    const push = ObjectiveActionSchema.parse({
      kind: 'push-ref',
      capability: 'land',
      visibility: 'external',
      contentIdentity: 'content-committed',
      evidenceKey: 'pushed-ref:commit-1:origin/feature/objective:',
      rung: 'pushed-ref',
      revisionId: 'revision-1',
      branch: 'feature/objective',
      remote: 'origin',
      commitSha: 'commit-1',
      expectedState: {
        target: 'origin/feature/objective',
        before: OBJECTIVE_ABSENT_REMOTE_REF_STATE
      }
    })
    expect(objectiveActionNaturalKey(push)).toEqual({
      kind: 'push-ref',
      commitSha: 'commit-1',
      remote: 'origin',
      branch: 'feature/objective'
    })
    expect('recovery' in push).toBe(false)
    expect(ObjectiveActionSchema.safeParse({ ...push, recovery: 'probe-only' }).success).toBe(false)

    const review = ObjectiveActionSchema.parse({
      kind: 'open-hosted-review',
      capability: 'land',
      visibility: 'external',
      contentIdentity: 'content-committed',
      evidenceKey: 'hosted-review:github:feature/objective:commit-1',
      rung: 'hosted-review',
      revisionId: 'revision-1',
      branch: 'feature/objective',
      base: 'main',
      headSha: 'commit-1',
      provider: 'github',
      expectedState: {
        target: 'github:repo-1:feature/objective',
        before: 'no-review'
      }
    })
    expect(objectiveActionNaturalKey(review)).toEqual({
      kind: 'open-hosted-review',
      provider: 'github',
      branch: 'feature/objective',
      headSha: 'commit-1'
    })
    expect('recovery' in review).toBe(false)
  })

  it('keeps rung results strict and specific to their observable effect', () => {
    expect(
      ObjectiveActionResultSchema.parse({
        kind: 'commit-recorded',
        naturalKey: {
          kind: 'commit-local-branch',
          revisionId: 'revision-1',
          fromContentIdentity: 'content-before'
        },
        commitSha: 'commit-1',
        contentIdentity: 'content-committed',
        outsideTerritoryPaths: ['notes/local.txt']
      })
    ).toMatchObject({
      kind: 'commit-recorded',
      commitSha: 'commit-1',
      outsideTerritoryPaths: ['notes/local.txt']
    })
    expect(
      ObjectiveActionResultSchema.parse({
        kind: 'push-recorded',
        naturalKey: {
          kind: 'push-ref',
          commitSha: 'commit-1',
          remote: 'origin',
          branch: 'feature/objective'
        },
        remoteSha: 'commit-1'
      })
    ).toMatchObject({ kind: 'push-recorded', remoteSha: 'commit-1' })
    expect(
      ObjectiveActionResultSchema.parse({
        kind: 'review-recorded',
        naturalKey: {
          kind: 'open-hosted-review',
          provider: 'github',
          branch: 'feature/objective',
          headSha: 'commit-1'
        },
        reviewNumber: 42,
        reviewUrl: 'https://github.com/acme/repo/pull/42'
      })
    ).toMatchObject({ kind: 'review-recorded', reviewNumber: 42 })
  })
})
