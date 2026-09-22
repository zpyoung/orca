import { describe, expect, it } from 'vitest'
import type { EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import { enrollmentForParallelCompatibility } from './fleet-remote-operations'

function input(kindPayload: Record<string, unknown>): EnrollInput {
  return {
    kind: 'objective',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    capabilities: { plan: 'on' },
    budget: { wallClockActiveMs: 60_000, turns: 12 },
    kindPayload
  }
}

describe('enrollmentForParallelCompatibility', () => {
  it('strips lanesEnabled and gates and clamps concurrency for a peer without the capability', () => {
    const enrollment = input({
      maxConcurrency: 5,
      lanesEnabled: true,
      gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 600 }]
    })

    const compatible = enrollmentForParallelCompatibility(enrollment, false)

    expect(compatible.kindPayload).toEqual({ maxConcurrency: 1 })
  })

  it('leaves the enrollment untouched when the peer supports parallel execution', () => {
    const enrollment = input({
      maxConcurrency: 5,
      lanesEnabled: true,
      gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 600 }]
    })

    expect(enrollmentForParallelCompatibility(enrollment, true)).toBe(enrollment)
  })

  it('leaves a non-objective enrollment untouched', () => {
    const enrollment: EnrollInput = {
      kind: 'hosted-review',
      repoId: 'repo-1',
      worktreeId: null,
      capabilities: {},
      budget: { wallClockActiveMs: null, turns: null },
      kindPayload: { gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 600 }] }
    }

    expect(enrollmentForParallelCompatibility(enrollment, false)).toBe(enrollment)
  })

  it('leaves an enrollment without gates or lanes untouched beyond the concurrency clamp', () => {
    const enrollment = input({ maxConcurrency: 5 })

    expect(enrollmentForParallelCompatibility(enrollment, false).kindPayload).toEqual({
      maxConcurrency: 1
    })
  })
})
