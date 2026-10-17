import { describe, expect, it } from 'vitest'
import { decideNext, type DecideNextInput } from './loop-decision'
import type {
  CheckOutcome,
  HoldSignals,
  IterationEvidence,
  LoopConfig,
  LoopRuntimeState
} from './loop-types'

const NOW = 10_000_000
const MINUTE = 60_000

const baseConfig: LoopConfig = {
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

const baseState: LoopRuntimeState = {
  state: 'running',
  iterationsCompleted: 1,
  activeMs: 0,
  costUsd: null,
  consecutiveCrashesThisIteration: 0,
  maxIterationsGranted: null,
  lastIterationEndedAt: NOW - 1000,
  nextWallClockTickAt: null
}

const baseHold: HoldSignals = {
  userPaused: false,
  stopRequested: null,
  awaitingApproval: false,
  connection: 'live',
  userTyping: false
}

function check(overrides: Partial<CheckOutcome> = {}): CheckOutcome {
  return {
    ran: true,
    pass: true,
    exitCode: 0,
    timedOut: false,
    stdoutTail: '',
    stderrTail: '',
    durationMs: 5,
    ...overrides
  }
}

function evidence(overrides: Partial<IterationEvidence> = {}): IterationEvidence {
  return {
    n: 1,
    attempt: 0,
    startedAt: NOW - 5000,
    endedAt: NOW - 1000,
    endReason: 'settled',
    check: null,
    evaluator: null,
    diff: null,
    treeBefore: 'tree-a',
    treeAfter: 'tree-b',
    costUsd: null,
    markers: [],
    protectedPathHits: [],
    checkpointCommit: null,
    settlement: 'settled',
    usageLimit: null,
    ...overrides
  }
}

function decide(
  overrides: {
    loop?: Partial<LoopConfig>
    state?: Partial<LoopRuntimeState>
    history?: DecideNextInput['history']
    latest?: IterationEvidence | null
    hold?: Partial<HoldSignals>
    queue?: DecideNextInput['queue']
  } = {}
) {
  const latest = overrides.latest === undefined ? evidence() : overrides.latest
  return decideNext({
    loop: { ...baseConfig, ...overrides.loop },
    state: { ...baseState, ...overrides.state },
    history: overrides.history ?? (latest ? [latest] : []),
    latest,
    now: NOW,
    hold: { ...baseHold, ...overrides.hold },
    queue: overrides.queue
  })
}

const START_REPEAT = { kind: 'start-iteration', freshSession: true, promptSource: 'repeat' }

describe('decideNext completion', () => {
  it('completes when the only configured check passes', () => {
    const action = decide({
      loop: { done: { check: { command: 'true', timeoutSeconds: 10, runWhen: 'every-iteration' } } },
      latest: evidence({ check: check() })
    })
    expect(action).toEqual({ kind: 'complete' })
  })

  it('does not complete when the check fails', () => {
    const action = decide({
      loop: { done: { check: { command: 'true', timeoutSeconds: 10, runWhen: 'every-iteration' } } },
      latest: evidence({ check: check({ pass: false, exitCode: 1 }) })
    })
    expect(action).toEqual(START_REPEAT)
  })

  it('completes when the only configured evaluator says met', () => {
    const action = decide({
      loop: { done: { evaluator: { condition: 'tests green' } } },
      latest: evidence({ evaluator: { verdict: 'met', reason: 'ok' } })
    })
    expect(action).toEqual({ kind: 'complete' })
  })

  it('does not complete when the evaluator says not-met or did not run', () => {
    const loop = { done: { evaluator: { condition: 'tests green' } } }
    expect(decide({ loop, latest: evidence({ evaluator: { verdict: 'not-met', reason: 'no' } }) })).toEqual(
      START_REPEAT
    )
    expect(decide({ loop, latest: evidence() })).toEqual(START_REPEAT)
  })

  it('with both signals, completes only when both pass', () => {
    const loop = {
      done: {
        check: { command: 'true', timeoutSeconds: 10, runWhen: 'every-iteration' as const },
        evaluator: { condition: 'tests green' }
      }
    }
    const met = { verdict: 'met' as const, reason: 'ok' }
    const notMet = { verdict: 'not-met' as const, reason: 'no' }
    expect(decide({ loop, latest: evidence({ check: check(), evaluator: met }) })).toEqual({
      kind: 'complete'
    })
    expect(decide({ loop, latest: evidence({ check: check(), evaluator: notMet }) })).toEqual(
      START_REPEAT
    )
    expect(
      decide({ loop, latest: evidence({ check: check({ pass: false, exitCode: 1 }), evaluator: met }) })
    ).toEqual(START_REPEAT)
  })

  it('on-claim ignores a passing check until the agent emits LOOP_DONE', () => {
    const loop = { done: { check: { command: 'true', timeoutSeconds: 10, runWhen: 'on-claim' as const } } }
    expect(decide({ loop, latest: evidence({ check: check() }) })).toEqual(START_REPEAT)
    expect(
      decide({ loop, latest: evidence({ check: check(), markers: [{ kind: 'done' }] }) })
    ).toEqual({ kind: 'complete' })
  })

  it('on-claim with a claim but a failing check keeps going', () => {
    const loop = { done: { check: { command: 'true', timeoutSeconds: 10, runWhen: 'on-claim' as const } } }
    const action = decide({
      loop,
      latest: evidence({ check: check({ pass: false, exitCode: 1 }), markers: [{ kind: 'done' }] })
    })
    expect(action).toEqual(START_REPEAT)
  })

  it('LOOP_DONE alone never completes', () => {
    expect(decide({ latest: evidence({ markers: [{ kind: 'done' }] }) })).toEqual(START_REPEAT)
    const loop = { done: { evaluator: { condition: 'x' } } }
    expect(decide({ loop, latest: evidence({ markers: [{ kind: 'done' }] }) })).toEqual(START_REPEAT)
  })
})

describe('decideNext caps', () => {
  it('pauses at the iteration cap and not one below it', () => {
    const loop = { caps: { maxIterations: 3 } }
    expect(decide({ loop, state: { iterationsCompleted: 2 } })).toEqual(START_REPEAT)
    expect(decide({ loop, state: { iterationsCompleted: 3 } })).toEqual({
      kind: 'pause',
      reason: 'cap-iterations'
    })
  })

  it('a granted iteration allowance replaces the configured cap', () => {
    const action = decide({
      loop: { caps: { maxIterations: 3 } },
      state: { iterationsCompleted: 3, maxIterationsGranted: 5 }
    })
    expect(action).toEqual(START_REPEAT)
    expect(
      decide({
        loop: { caps: { maxIterations: 3 } },
        state: { iterationsCompleted: 5, maxIterationsGranted: 5 }
      })
    ).toEqual({ kind: 'pause', reason: 'cap-iterations' })
  })

  it('wall-clock cap counts activeMs, not elapsed time since the last iteration', () => {
    const loop = { caps: { maxActiveMinutes: 10 } }
    const longIdle = { lastIterationEndedAt: NOW - 120 * MINUTE }
    expect(decide({ loop, state: { ...longIdle, activeMs: 10 * MINUTE - 1 } })).toEqual(START_REPEAT)
    expect(decide({ loop, state: { ...longIdle, activeMs: 10 * MINUTE } })).toEqual({
      kind: 'pause',
      reason: 'cap-time'
    })
  })

  it('pauses at the cost cap and not below it', () => {
    const loop = { caps: { maxCostUsd: 5 } }
    expect(decide({ loop, state: { costUsd: 4.99 } })).toEqual(START_REPEAT)
    expect(decide({ loop, state: { costUsd: 5 } })).toEqual({ kind: 'pause', reason: 'cap-cost' })
    expect(decide({ loop, state: { costUsd: null } })).toEqual(START_REPEAT)
  })

  it('completion beats a cap that fires on the same iteration', () => {
    const action = decide({
      loop: {
        caps: { maxIterations: 1 },
        done: { check: { command: 'true', timeoutSeconds: 10, runWhen: 'every-iteration' } }
      },
      latest: evidence({ check: check() })
    })
    expect(action).toEqual({ kind: 'complete' })
  })
})

describe('decideNext crashes and settlement', () => {
  it('retries the first crash in a fresh session', () => {
    const latest = evidence({ endReason: 'crashed', settlement: 'crashed' })
    expect(decide({ latest, state: { consecutiveCrashesThisIteration: 1 } })).toEqual({
      kind: 'retry-crashed',
      freshSession: true
    })
  })

  it('pauses on a second crash in the same iteration', () => {
    const first = evidence({ endReason: 'crashed', settlement: 'crashed', attempt: 0 })
    const second = evidence({ endReason: 'crashed', settlement: 'crashed', attempt: 1 })
    expect(decide({ latest: second, history: [first, second] })).toEqual({
      kind: 'pause',
      reason: 'crashed'
    })
    expect(decide({ latest: second, state: { consecutiveCrashesThisIteration: 2 } })).toEqual({
      kind: 'pause',
      reason: 'crashed'
    })
  })

  it('a crash in a later iteration is again a first crash', () => {
    const old = evidence({ n: 1, endReason: 'crashed', settlement: 'crashed' })
    const settled = evidence({ n: 1, attempt: 1 })
    const fresh = evidence({ n: 2, endReason: 'crashed', settlement: 'crashed' })
    expect(decide({ latest: fresh, history: [old, settled, fresh] })).toEqual({
      kind: 'retry-crashed',
      freshSession: true
    })
  })

  it('waits on an unverifiable settlement instead of declaring a result', () => {
    const latest = evidence({ settlement: 'unverifiable' })
    expect(decide({ latest })).toEqual({
      kind: 'wait',
      until: 'agent-idle',
      reason: 'unverifiable'
    })
  })

  it('pauses with the matching reason when the iteration was interrupted or stopped', () => {
    expect(decide({ latest: evidence({ endReason: 'interrupted' }) })).toEqual({
      kind: 'pause',
      reason: 'interrupted-by-restart'
    })
    expect(decide({ latest: evidence({ endReason: 'stopped', settlement: 'aborted' }) })).toEqual({
      kind: 'pause',
      reason: 'user'
    })
  })
})

describe('decideNext precedence', () => {
  it('protected-path pause beats a cap that fires at the same time', () => {
    const action = decide({
      loop: { caps: { maxIterations: 1 } },
      state: { iterationsCompleted: 1 },
      latest: evidence({ protectedPathHits: ['.github/workflows/ci.yml'] })
    })
    expect(action).toEqual({
      kind: 'pause',
      reason: 'protected-path',
      detail: '.github/workflows/ci.yml'
    })
  })

  it('protected-path pause beats a BLOCKED marker', () => {
    const action = decide({
      latest: evidence({
        protectedPathHits: ['a'],
        markers: [{ kind: 'blocked', text: 'need help' }]
      })
    })
    expect(action).toMatchObject({ kind: 'pause', reason: 'protected-path' })
  })

  it('marker pause beats a cap', () => {
    const loop = { caps: { maxIterations: 1 } }
    expect(
      decide({
        loop,
        latest: evidence({ markers: [{ kind: 'blocked', text: 'stuck on auth' }] })
      })
    ).toEqual({ kind: 'pause', reason: 'agent-blocked', detail: 'stuck on auth' })
    expect(
      decide({
        loop,
        latest: evidence({ markers: [{ kind: 'decide', text: 'A or B?' }] })
      })
    ).toEqual({ kind: 'pause', reason: 'agent-decide', detail: 'A or B?' })
  })

  it('cap pause beats no-progress, and no-progress beats usage-limit', () => {
    const stuck = (n: number) => evidence({ n, treeAfter: 'tree-a' })
    const history = [stuck(1), stuck(2), stuck(3)]
    const usageLimit = { provider: 'claude' as const, resetsAt: null }
    expect(
      decide({
        loop: { noProgress: true, caps: { maxIterations: 3 } },
        state: { iterationsCompleted: 3 },
        history,
        latest: history[2]
      })
    ).toEqual({ kind: 'pause', reason: 'cap-iterations' })
    expect(
      decide({
        loop: { noProgress: true },
        history,
        latest: { ...stuck(3), usageLimit }
      })
    ).toEqual({ kind: 'pause', reason: 'no-progress' })
  })

  it('usage-limit pause beats ask-before-next', () => {
    const action = decide({
      loop: { askBeforeNext: true },
      latest: evidence({ usageLimit: { provider: 'codex', resetsAt: null } })
    })
    expect(action).toMatchObject({ kind: 'pause', reason: 'usage-limit' })
  })

  it('ask-before-next pause comes before the next iteration', () => {
    expect(decide({ loop: { askBeforeNext: true } })).toEqual({
      kind: 'pause',
      reason: 'ask-before-next'
    })
  })

  it('stopRequested after-iteration overrides starting the next iteration', () => {
    expect(decide({ hold: { stopRequested: 'after-iteration' } })).toMatchObject({
      kind: 'pause',
      reason: 'user'
    })
  })

  it('stopRequested overrides completion', () => {
    const action = decide({
      loop: { done: { evaluator: { condition: 'x' } } },
      latest: evidence({ evaluator: { verdict: 'met', reason: 'ok' } }),
      hold: { stopRequested: 'after-iteration' }
    })
    expect(action).toMatchObject({ kind: 'pause', reason: 'user' })
  })

  it('userPaused pauses with reason user', () => {
    expect(decide({ hold: { userPaused: true } })).toMatchObject({ kind: 'pause', reason: 'user' })
  })
})

describe('decideNext usage limits and progress', () => {
  it('pauses on usage-limit evidence', () => {
    const action = decide({
      latest: evidence({ usageLimit: { provider: 'claude', resetsAt: NOW + MINUTE } })
    })
    expect(action).toMatchObject({ kind: 'pause', reason: 'usage-limit' })
  })

  it('waits for the reset when resumeAtLimitReset is on and the reset is in the future', () => {
    const action = decide({
      loop: { resumeAtLimitReset: true },
      latest: evidence({ usageLimit: { provider: 'claude', resetsAt: NOW + MINUTE } })
    })
    expect(action).toEqual({ kind: 'wait', until: NOW + MINUTE, reason: 'limit-reset' })
  })

  it('pauses when the reset time is unknown even with resumeAtLimitReset', () => {
    const action = decide({
      loop: { resumeAtLimitReset: true },
      latest: evidence({ usageLimit: { provider: 'claude', resetsAt: null } })
    })
    expect(action).toMatchObject({ kind: 'pause', reason: 'usage-limit' })
  })

  it('starts again once the reset time has passed', () => {
    const action = decide({
      loop: { resumeAtLimitReset: true },
      latest: evidence({ usageLimit: { provider: 'claude', resetsAt: NOW - 1 } })
    })
    expect(action).toEqual(START_REPEAT)
  })

  it('pauses no-progress after exactly three unchanged iterations', () => {
    const stuck = (n: number) => evidence({ n, treeAfter: 'tree-a' })
    const loop = { noProgress: true }
    expect(decide({ loop, history: [stuck(1), stuck(2)], latest: stuck(2) })).toEqual(START_REPEAT)
    expect(decide({ loop, history: [stuck(1), stuck(2), stuck(3)], latest: stuck(3) })).toEqual({
      kind: 'pause',
      reason: 'no-progress'
    })
  })

  it('ignores no-progress when the option is off', () => {
    const stuck = (n: number) => evidence({ n, treeAfter: 'tree-a' })
    expect(decide({ history: [stuck(1), stuck(2), stuck(3)], latest: stuck(3) })).toEqual(START_REPEAT)
  })
})

describe('decideNext pacing', () => {
  it('on-idle starts immediately', () => {
    expect(decide()).toEqual(START_REPEAT)
  })

  it('starts the first iteration when there is no evidence', () => {
    expect(decide({ latest: null, state: { iterationsCompleted: 0, lastIterationEndedAt: null } })).toEqual(
      START_REPEAT
    )
  })

  it('interval from-end waits until lastIterationEndedAt plus the interval', () => {
    const loop = { pacing: { kind: 'interval' as const, minutes: 5, anchor: 'from-end' as const } }
    const endedAt = NOW - 2 * MINUTE
    expect(decide({ loop, state: { lastIterationEndedAt: endedAt } })).toEqual({
      kind: 'wait',
      until: endedAt + 5 * MINUTE,
      reason: 'pacing'
    })
  })

  it('interval from-end starts once the interval has elapsed', () => {
    const loop = { pacing: { kind: 'interval' as const, minutes: 5, anchor: 'from-end' as const } }
    expect(decide({ loop, state: { lastIterationEndedAt: NOW - 5 * MINUTE } })).toEqual(START_REPEAT)
  })

  it('interval wall-clock waits for the next anchor tick', () => {
    const loop = { pacing: { kind: 'interval' as const, minutes: 5, anchor: 'wall-clock' as const } }
    expect(decide({ loop, state: { nextWallClockTickAt: NOW + 3 * MINUTE } })).toEqual({
      kind: 'wait',
      until: NOW + 3 * MINUTE,
      reason: 'pacing'
    })
    expect(decide({ loop, state: { nextWallClockTickAt: NOW } })).toEqual(START_REPEAT)
  })

  it('freshSession follows the stored session policy', () => {
    expect(decide({ loop: { sessionPolicy: 'continue' } })).toEqual({
      kind: 'start-iteration',
      freshSession: false,
      promptSource: 'repeat'
    })
  })
})

describe('decideNext queue', () => {
  const queueLoop = (repeatQueue: boolean): Partial<LoopConfig> => ({
    promptSource: { kind: 'queue', repeatQueue }
  })

  it('starts the earliest pending item by position', () => {
    const action = decide({
      loop: queueLoop(false),
      queue: [
        { id: 'c', position: 2, state: 'pending' },
        { id: 'a', position: 0, state: 'done' },
        { id: 'b', position: 1, state: 'pending' }
      ]
    })
    expect(action).toEqual({
      kind: 'start-iteration',
      freshSession: true,
      promptSource: { queueItemId: 'b' }
    })
  })

  it('completes when the queue is exhausted and no done signal is configured', () => {
    const action = decide({
      loop: queueLoop(false),
      queue: [{ id: 'a', position: 0, state: 'done' }]
    })
    expect(action).toEqual({ kind: 'complete' })
  })

  it('pauses queue-exhausted when a done signal is configured and unmet', () => {
    const action = decide({
      loop: { ...queueLoop(false), done: { evaluator: { condition: 'x' } } },
      queue: [{ id: 'a', position: 0, state: 'done' }]
    })
    expect(action).toMatchObject({ kind: 'pause', reason: 'queue-exhausted' })
  })

  it('restarts from the first item when repeatQueue is on', () => {
    const action = decide({
      loop: queueLoop(true),
      queue: [
        { id: 'b', position: 1, state: 'done' },
        { id: 'a', position: 0, state: 'done' }
      ]
    })
    expect(action).toEqual({
      kind: 'start-iteration',
      freshSession: true,
      promptSource: { queueItemId: 'a' }
    })
  })

  it('treats a missing or empty queue as exhausted even with repeatQueue', () => {
    expect(decide({ loop: queueLoop(true), queue: [] })).toEqual({ kind: 'complete' })
    expect(decide({ loop: queueLoop(false) })).toEqual({ kind: 'complete' })
  })

  it('completes by done signal before reporting exhaustion', () => {
    const action = decide({
      loop: { ...queueLoop(false), done: { evaluator: { condition: 'x' } } },
      latest: evidence({ evaluator: { verdict: 'met', reason: 'ok' } }),
      queue: [{ id: 'a', position: 0, state: 'done' }]
    })
    expect(action).toEqual({ kind: 'complete' })
  })
})

describe('decideNext holds', () => {
  it('waits for the user to stop typing', () => {
    expect(decide({ hold: { userTyping: true } })).toEqual({
      kind: 'wait',
      until: 'user-idle',
      reason: 'user-typing'
    })
  })

  it('waits while the agent is awaiting approval', () => {
    expect(decide({ hold: { awaitingApproval: true } })).toEqual({
      kind: 'wait',
      until: 'agent-idle',
      reason: 'agent-busy'
    })
  })

  it('waits when the connection is unverifiable', () => {
    expect(decide({ hold: { connection: 'unverifiable' } })).toEqual({
      kind: 'wait',
      until: 'agent-idle',
      reason: 'unverifiable'
    })
  })

  it('an unverifiable connection blocks a crash retry', () => {
    const latest = evidence({ endReason: 'crashed', settlement: 'crashed' })
    expect(decide({ latest, hold: { connection: 'unverifiable' } })).toMatchObject({
      kind: 'wait',
      reason: 'unverifiable'
    })
  })

  it('pacing wait wins over the typing hold', () => {
    const loop = { pacing: { kind: 'interval' as const, minutes: 5, anchor: 'from-end' as const } }
    const action = decide({
      loop,
      state: { lastIterationEndedAt: NOW - MINUTE },
      hold: { userTyping: true }
    })
    expect(action).toMatchObject({ kind: 'wait', reason: 'pacing' })
  })
})

describe('decideNext totality', () => {
  it('returns the same action for the same input', () => {
    const input = { loop: { caps: { maxIterations: 1 } }, state: { iterationsCompleted: 1 } }
    expect(decide(input)).toEqual(decide(input))
  })

  it('does not throw for a stopRequested now with no evidence', () => {
    expect(decide({ latest: null, hold: { stopRequested: 'now' } })).toMatchObject({
      kind: 'pause',
      reason: 'user'
    })
  })
})
