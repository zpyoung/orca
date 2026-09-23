import { describe, expect, it } from 'vitest'
import {
  ObjectiveDetailSchema,
  ObjectiveDetailGateSchema,
  ObjectiveDetailNodeSchema,
  ObjectiveDetailPendingPatchSchema,
  ObjectiveLandingProjectionSchema
} from './detail-types'

const CONTRACT = {
  objectiveText: 'Implement the objective',
  tier: 'standard' as const,
  landingBar: 'hosted-review' as const,
  maxConcurrency: 1,
  workspaceKind: 'git' as const,
  writeTerritory: ['src/**'],
  roleAgents: {},
  sitterOverrides: {}
}

describe('objective landing projection boundaries', () => {
  it('retains owner-only lineage and rung payload fields in the internal projection', () => {
    expect(
      ObjectiveLandingProjectionSchema.parse({
        rung: 'hosted-review',
        revisionId: 'revision-1',
        contentIdentity: 'content-1',
        fromContentIdentity: 'checked-content',
        provider: 'github',
        reviewNumber: 42,
        reviewUrl: 'https://github.com/acme/repo/pull/42',
        branch: 'feature/objective',
        headSha: 'commit-1',
        base: 'main',
        atMs: 100
      })
    ).toMatchObject({
      fromContentIdentity: 'checked-content',
      provider: 'github',
      reviewNumber: 42
    })
  })

  it('keeps objective detail landing rows on the strict three-key wire pick', () => {
    const detail = {
      contract: CONTRACT,
      revisions: [],
      nodes: [],
      verdicts: [],
      landing: [{ rung: 'hosted-review', contentIdentity: 'content-1', atMs: 100 }],
      asOfMs: 100
    }
    expect(ObjectiveDetailSchema.safeParse(detail).success).toBe(true)
    expect(
      ObjectiveDetailSchema.safeParse({
        ...detail,
        landing: [{ ...detail.landing[0], fromContentIdentity: 'checked-content' }]
      }).success
    ).toBe(false)
  })
})

describe('objective detail plan-quality fields', () => {
  const NODE = {
    taskKey: 'task-a',
    title: 'Task A',
    revisionId: 'revision-1',
    orchestrationTaskId: null,
    dispatchId: null,
    state: 'pending' as const,
    criteria: []
  }

  it('accepts a node with territory and overrun paths', () => {
    expect(
      ObjectiveDetailNodeSchema.safeParse({
        ...NODE,
        territory: ['src/**'],
        overrunPaths: ['docs/outside.md']
      }).success
    ).toBe(true)
  })

  it('rejects an unknown key on the node schema', () => {
    expect(ObjectiveDetailNodeSchema.safeParse({ ...NODE, extra: true }).success).toBe(false)
  })

  it('accepts a pending patch with a null rejection and rejects an unknown key', () => {
    const patch = {
      id: 'patch-1',
      status: 'pending' as const,
      rejection: null,
      touchedTaskKeys: []
    }
    expect(ObjectiveDetailPendingPatchSchema.safeParse(patch).success).toBe(true)
    expect(ObjectiveDetailPendingPatchSchema.safeParse({ ...patch, extra: true }).success).toBe(
      false
    )
  })

  it('accepts a pending patch that omits rejection (C12)', () => {
    const { rejection: _rejection, ...patchWithoutRejection } = {
      id: 'patch-1',
      status: 'pending' as const,
      rejection: null,
      touchedTaskKeys: []
    }
    expect(ObjectiveDetailPendingPatchSchema.safeParse(patchWithoutRejection).success).toBe(true)
  })

  it('accepts a gate with and without a last result', () => {
    const gate = { name: 'lint', command: 'pnpm lint', timeoutSeconds: 600 }
    expect(ObjectiveDetailGateSchema.safeParse(gate).success).toBe(true)
    expect(
      ObjectiveDetailGateSchema.safeParse({
        ...gate,
        lastResult: {
          contentIdentity: 'content-1',
          pass: false,
          exitCode: 1,
          timedOut: false,
          completedAtMs: 100
        }
      }).success
    ).toBe(true)
  })

  it('parses a full detail payload carrying every new C12 field', () => {
    const detail = {
      contract: CONTRACT,
      revisions: [],
      nodes: [{ ...NODE, territory: ['src/**'], overrunPaths: [] }],
      verdicts: [],
      landing: [],
      planLint: {
        findings: [],
        truncated: false,
        conflictPairs: [],
        criticalPathLength: 1,
        maxWidth: 1
      },
      assumptions: [
        { claim: 'The API is stable', dependentTaskKeys: ['task-a'], status: 'verified' }
      ],
      planReviews: [
        {
          targetKind: 'revision' as const,
          targetId: 'revision-1',
          round: 1 as const,
          verdict: 'approve' as const,
          summary: 'Looks solid',
          createdAtMs: 100
        }
      ],
      pendingPatch: {
        id: 'patch-1',
        status: 'rejected' as const,
        rejection: 'names a frozen task',
        touchedTaskKeys: ['task-b']
      },
      gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 600 }],
      asOfMs: 100
    }
    expect(ObjectiveDetailSchema.safeParse(detail).success).toBe(true)
  })

  it('accepts noGateDeclared without a gates array', () => {
    const detail = {
      contract: CONTRACT,
      revisions: [],
      nodes: [],
      verdicts: [],
      landing: [],
      noGateDeclared: true as const,
      asOfMs: 100
    }
    expect(ObjectiveDetailSchema.safeParse(detail).success).toBe(true)
  })
})
