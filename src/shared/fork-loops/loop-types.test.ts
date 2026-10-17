import { describe, expect, it } from 'vitest'
import {
  defaultSessionPolicyForPreset,
  LOOP_NO_PROGRESS_ITERATIONS,
  LoopConfigSchema,
  LoopCreateInputSchema,
  LoopSnapshotSchema,
  PauseReasonSchema
} from './loop-types'

const minimalConfig = {
  promptSource: { kind: 'repeat', body: 'keep going' },
  pacing: { kind: 'on-idle' },
  sessionPolicy: 'fresh',
  done: {},
  caps: {},
  noProgress: false,
  checkpointCommits: false,
  askBeforeNext: false,
  resumeAtLimitReset: false
}

const PAUSE_REASONS = [
  'user',
  'cap-iterations',
  'cap-time',
  'cap-cost',
  'no-progress',
  'protected-path',
  'agent-blocked',
  'agent-decide',
  'crashed',
  'usage-limit',
  'interrupted-by-restart',
  'unverifiable',
  'ask-before-next',
  'queue-exhausted'
]

describe('LoopConfigSchema', () => {
  it('accepts a minimal until-done config', () => {
    expect(LoopConfigSchema.safeParse(minimalConfig).success).toBe(true)
  })

  it('rejects an interval pacing of zero minutes', () => {
    const result = LoopConfigSchema.safeParse({
      ...minimalConfig,
      pacing: { kind: 'interval', minutes: 0, anchor: 'from-end' }
    })
    expect(result.success).toBe(false)
  })

  it('rejects a check timeout above 600 seconds', () => {
    const result = LoopConfigSchema.safeParse({
      ...minimalConfig,
      done: { check: { command: 'true', timeoutSeconds: 601, runWhen: 'every-iteration' } }
    })
    expect(result.success).toBe(false)
  })

  it('accepts a check timeout at the 600 second ceiling', () => {
    const result = LoopConfigSchema.safeParse({
      ...minimalConfig,
      done: { check: { command: 'true', timeoutSeconds: 600, runWhen: 'on-claim' } }
    })
    expect(result.success).toBe(true)
  })
})

describe('defaultSessionPolicyForPreset', () => {
  it('maps each preset to its session policy', () => {
    expect(defaultSessionPolicyForPreset('until-done')).toBe('fresh')
    expect(defaultSessionPolicyForPreset('interval')).toBe('continue')
    expect(defaultSessionPolicyForPreset('queue')).toBe('continue')
  })
})

describe('PauseReasonSchema', () => {
  it.each(PAUSE_REASONS)('accepts %s', (reason) => {
    expect(PauseReasonSchema.safeParse(reason).success).toBe(true)
  })

  it('rejects an unlisted reason', () => {
    expect(PauseReasonSchema.safeParse('evaluator-impossible').success).toBe(false)
  })
})

describe('LOOP_NO_PROGRESS_ITERATIONS', () => {
  it('is fixed at three', () => {
    expect(LOOP_NO_PROGRESS_ITERATIONS).toBe(3)
  })
})

describe('LoopCreateInputSchema', () => {
  const input = {
    worktreeId: 'wt-1',
    name: 'Queue run',
    agent: 'claude',
    preset: 'queue',
    config: { ...minimalConfig, promptSource: { kind: 'queue', repeatQueue: false } }
  }

  it('accepts initial queue items', () => {
    const result = LoopCreateInputSchema.safeParse({ ...input, queueItems: ['one', 'two'] })
    expect(result.success).toBe(true)
  })

  it('treats queue items as optional', () => {
    expect(LoopCreateInputSchema.safeParse(input).success).toBe(true)
  })

  it('rejects an empty queue item', () => {
    expect(LoopCreateInputSchema.safeParse({ ...input, queueItems: [''] }).success).toBe(false)
  })
})

describe('LoopSnapshotSchema queue', () => {
  const snapshot = {
    id: 'l1',
    worktreeId: 'wt-1',
    name: 'Run',
    agent: 'claude',
    preset: 'queue',
    config: minimalConfig,
    state: 'running',
    iterationsCompleted: 0,
    detached: false,
    skippedTicks: 0,
    activeMs: 0,
    recentIterations: []
  }

  it('treats the queue as optional for older hosts', () => {
    expect(LoopSnapshotSchema.safeParse(snapshot).success).toBe(true)
  })

  it('accepts ordered queue items in every state', () => {
    const queue = [
      { id: 'a', position: 0, body: 'one', state: 'done' },
      { id: 'b', position: 1, body: 'two', state: 'in-flight' },
      { id: 'c', position: 2, body: 'three', state: 'pending' }
    ]
    expect(LoopSnapshotSchema.safeParse({ ...snapshot, queue }).success).toBe(true)
  })

  it('rejects an unknown queue item state', () => {
    const queue = [{ id: 'a', position: 0, body: 'one', state: 'running' }]
    expect(LoopSnapshotSchema.safeParse({ ...snapshot, queue }).success).toBe(false)
  })
})
