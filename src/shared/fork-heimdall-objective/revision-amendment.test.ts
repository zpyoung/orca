import { describe, expect, it } from 'vitest'
import {
  applyRevisionAmendmentPatch,
  revisionAmendmentTouchedTaskKeys,
  unknownAmendmentDropTaskKeys,
  type RevisionAmendmentPatch
} from './revision-amendment'
import type { ObjectivePlanTask } from './plan-schema'

function task(taskKey: string, overrides: Partial<ObjectivePlanTask> = {}): ObjectivePlanTask {
  return {
    taskKey,
    title: `Task ${taskKey}`,
    spec: `Implement ${taskKey}`,
    deps: [],
    criteria: [{ body: `${taskKey} works`, shellCheckable: true, checkCommand: 'pnpm check' }],
    declaresDependencyChange: false,
    ...overrides
  }
}

function patch(overrides: Partial<RevisionAmendmentPatch> = {}): RevisionAmendmentPatch {
  return {
    digest: 'digest-1',
    attestation: 'Attested amendment.',
    upsertTasks: [],
    dropTaskKeys: [],
    ...overrides
  }
}

describe('applyRevisionAmendmentPatch', () => {
  it('preserves the order of tasks the patch does not touch', () => {
    const current = [task('a'), task('b'), task('c')]
    const outcome = applyRevisionAmendmentPatch(current, patch())
    expect(outcome).toEqual({ ok: true, plan: current })
  })

  it('replaces an upserted task in place', () => {
    const current = [task('a'), task('b'), task('c')]
    const replacement = task('b', { title: 'Revised B' })
    const outcome = applyRevisionAmendmentPatch(current, patch({ upsertTasks: [replacement] }))
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.plan.map((item) => item.taskKey)).toEqual(['a', 'b', 'c'])
      expect(outcome.plan[1]).toEqual(replacement)
    }
  })

  it('appends a genuinely new task at the end', () => {
    const current = [task('a')]
    const outcome = applyRevisionAmendmentPatch(current, patch({ upsertTasks: [task('b')] }))
    expect(outcome.ok).toBe(true)
    if (outcome.ok) {
      expect(outcome.plan.map((item) => item.taskKey)).toEqual(['a', 'b'])
    }
  })

  it('rejects a patch whose result introduces a dependency cycle', () => {
    const current = [task('a'), task('b')]
    const outcome = applyRevisionAmendmentPatch(
      current,
      patch({ upsertTasks: [task('a', { deps: ['b'] }), task('b', { deps: ['a'] })] })
    )
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid-dependency-graph' })
  })
})

describe('unknownAmendmentDropTaskKeys', () => {
  it('lists drop keys that name no task in the current plan', () => {
    const current = [task('a'), task('b')]
    const result = unknownAmendmentDropTaskKeys(
      current,
      patch({ dropTaskKeys: ['b', 'missing-1', 'missing-2'] })
    )
    expect(result).toEqual(['missing-1', 'missing-2'])
  })
})

describe('revisionAmendmentTouchedTaskKeys', () => {
  it('returns the union of upserted and dropped task keys', () => {
    const result = revisionAmendmentTouchedTaskKeys(
      patch({ upsertTasks: [task('a'), task('b')], dropTaskKeys: ['b', 'c'] })
    )
    expect(new Set(result)).toEqual(new Set(['a', 'b', 'c']))
  })
})
