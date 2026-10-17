import { describe, expect, it, vi } from 'vitest'
import type { LoopSnapshot, LoopWorktreeSummary } from '../../shared/fork-loops/loop-types'
import { LoopStoreError } from './loop-database'
import type { LoopService } from './loop-service'
import { attachWorktreeLoopSummaries, summarizeWorktreeLoops } from './worktree-ps-loop-summary'

function loop(overrides: Partial<LoopSnapshot> & { id: string }): LoopSnapshot {
  return {
    worktreeId: 'repo::/wt',
    name: overrides.id,
    agent: 'claude',
    preset: 'until-done',
    config: {
      promptSource: { kind: 'repeat', body: 'go' },
      pacing: { kind: 'on-idle' },
      sessionPolicy: 'fresh',
      done: {},
      caps: {},
      noProgress: true,
      checkpointCommits: false,
      askBeforeNext: false,
      resumeAtLimitReset: false
    },
    state: 'running',
    iterationsCompleted: 0,
    detached: false,
    skippedTicks: 0,
    activeMs: 0,
    recentIterations: [],
    ...overrides
  }
}

describe('summarizeWorktreeLoops', () => {
  it('returns undefined when the worktree has no loops', () => {
    expect(summarizeWorktreeLoops([], 'repo::/wt')).toBeUndefined()
    expect(
      summarizeWorktreeLoops([loop({ id: 'a', worktreeId: 'repo::/other' })], 'repo::/wt')
    ).toBeUndefined()
  })

  it('prefers a running loop over a newer paused one', () => {
    const summary = summarizeWorktreeLoops(
      [
        loop({ id: 'newer-paused', state: 'paused', pauseReason: 'user' }),
        loop({ id: 'older-running', state: 'running', iterationsCompleted: 4 })
      ],
      'repo::/wt'
    )
    expect(summary?.primary.id).toBe('older-running')
    expect(summary?.loopCount).toBe(2)
  })

  it('treats needs-you like running when picking the primary', () => {
    const summary = summarizeWorktreeLoops(
      [loop({ id: 'paused', state: 'paused' }), loop({ id: 'asking', state: 'needs-you' })],
      'repo::/wt'
    )
    expect(summary?.primary.id).toBe('asking')
  })

  it('takes the first listed loop when none is live', () => {
    const summary = summarizeWorktreeLoops(
      [loop({ id: 'recent', state: 'completed' }), loop({ id: 'old', state: 'stopped' })],
      'repo::/wt'
    )
    expect(summary?.primary.id).toBe('recent')
  })

  it('takes the most recently updated of several live loops', () => {
    const summary = summarizeWorktreeLoops(
      [loop({ id: 'first', state: 'needs-you' }), loop({ id: 'second', state: 'running' })],
      'repo::/wt'
    )
    expect(summary?.primary.id).toBe('first')
  })

  it('projects the primary fields and omits unset optionals', () => {
    const plain = summarizeWorktreeLoops([loop({ id: 'a', iterationsCompleted: 2 })], 'repo::/wt')
    expect(plain).toEqual({
      loopCount: 1,
      primary: { id: 'a', name: 'a', state: 'running', iterationsCompleted: 2 }
    })
    const detailed = summarizeWorktreeLoops(
      [
        loop({
          id: 'b',
          state: 'paused',
          pauseReason: 'cap-iterations',
          iterationsCompleted: 10,
          config: { ...loop({ id: 'b' }).config, caps: { maxIterations: 10 } }
        })
      ],
      'repo::/wt'
    )
    expect(detailed?.primary).toEqual({
      id: 'b',
      name: 'b',
      state: 'paused',
      pauseReason: 'cap-iterations',
      iterationsCompleted: 10,
      maxIterations: 10
    })
  })
})

describe('attachWorktreeLoopSummaries', () => {
  function psSummary(worktreeId: string): { worktreeId: string; loop?: LoopWorktreeSummary } {
    return { worktreeId }
  }

  it('sets loop only on worktrees that have loops', () => {
    const summaries = new Map([
      ['repo::/wt', psSummary('repo::/wt')],
      ['repo::/quiet', psSummary('repo::/quiet')]
    ])
    const service = { list: vi.fn(() => [loop({ id: 'a' })]) }
    attachWorktreeLoopSummaries(summaries, () => service)
    expect(summaries.get('repo::/wt')?.loop?.primary.id).toBe('a')
    expect(summaries.get('repo::/quiet')).not.toHaveProperty('loop')
  })

  it('omits the field when the runtime has no loop service', () => {
    const summaries = new Map([['repo::/wt', psSummary('repo::/wt')]])
    attachWorktreeLoopSummaries(summaries, () => {
      throw new LoopStoreError('loop_runtime_unavailable', 'no loops')
    })
    expect(summaries.get('repo::/wt')).not.toHaveProperty('loop')
  })

  it('never fails the listing when the loop store throws', () => {
    const summaries = new Map([['repo::/wt', psSummary('repo::/wt')]])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const service: Pick<LoopService, 'list'> = {
      list: () => {
        throw new Error('db locked')
      }
    }
    attachWorktreeLoopSummaries(summaries, () => service)
    expect(summaries.get('repo::/wt')).not.toHaveProperty('loop')
    warn.mockRestore()
  })
})
