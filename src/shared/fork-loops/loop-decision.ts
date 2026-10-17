import { isNoProgress } from './loop-progress'
import type {
  HoldSignals,
  IterationEvidence,
  IterationRecord,
  LoopConfig,
  LoopRuntimeState,
  PauseReason,
  WaitReason
} from './loop-types'

const MS_PER_MINUTE = 60_000

export type LoopQueueItemView = {
  id: string
  position: number
  state: 'pending' | 'in-flight' | 'done'
}

export type LoopAction =
  | {
      kind: 'start-iteration'
      freshSession: boolean
      promptSource: 'repeat' | { queueItemId: string }
    }
  | { kind: 'wait'; until: number | 'agent-idle' | 'user-idle'; reason: WaitReason }
  | { kind: 'pause'; reason: PauseReason; detail?: string }
  | { kind: 'complete' }
  | { kind: 'retry-crashed'; freshSession: true }

export type DecideNextInput = {
  loop: LoopConfig
  state: LoopRuntimeState
  history: IterationRecord[]
  latest: IterationEvidence | null
  now: number
  hold: HoldSignals
  /** Queue items for `promptSource.kind === 'queue'`; absent is treated as an empty queue. */
  queue?: readonly LoopQueueItemView[]
}

function pause(reason: PauseReason, detail?: string): LoopAction {
  return detail === undefined ? { kind: 'pause', reason } : { kind: 'pause', reason, detail }
}

function crashedAttemptCount(
  history: IterationRecord[],
  latest: IterationEvidence,
  state: LoopRuntimeState
): number {
  const attempts = new Set<number>([latest.attempt])
  for (const record of history) {
    if (record.n === latest.n && record.endReason === 'crashed') {
      attempts.add(record.attempt)
    }
  }
  return Math.max(attempts.size, state.consecutiveCrashesThisIteration)
}

function hasDoneSignal(done: LoopConfig['done']): boolean {
  return done.check !== undefined || done.evaluator !== undefined
}

/** A `LOOP_DONE` marker only arms an `on-claim` check; it never counts as a signal by itself. */
function doneSignalsPassed(done: LoopConfig['done'], latest: IterationEvidence): boolean {
  if (!hasDoneSignal(done)) {
    return false
  }
  if (done.check) {
    const claimed = latest.markers.some((marker) => marker.kind === 'done')
    if (done.check.runWhen === 'on-claim' && !claimed) {
      return false
    }
    if (!latest.check?.ran || !latest.check.pass) {
      return false
    }
  }
  if (done.evaluator && latest.evaluator?.verdict !== 'met') {
    return false
  }
  return true
}

function capPause(loop: LoopConfig, state: LoopRuntimeState): LoopAction | null {
  const maxIterations = state.maxIterationsGranted ?? loop.caps.maxIterations
  if (maxIterations !== undefined && state.iterationsCompleted >= maxIterations) {
    return pause('cap-iterations')
  }
  const { maxActiveMinutes, maxCostUsd } = loop.caps
  if (maxActiveMinutes !== undefined && state.activeMs >= maxActiveMinutes * MS_PER_MINUTE) {
    return pause('cap-time')
  }
  if (maxCostUsd !== undefined && state.costUsd !== null && state.costUsd >= maxCostUsd) {
    return pause('cap-cost')
  }
  return null
}

function evidencePause(
  input: DecideNextInput,
  latest: IterationEvidence
): LoopAction | null {
  const { loop, state, history, now } = input
  if (latest.protectedPathHits.length > 0) {
    return pause('protected-path', latest.protectedPathHits.join(', '))
  }
  const blocked = latest.markers.find((marker) => marker.kind === 'blocked')
  if (blocked) {
    return pause('agent-blocked', blocked.text)
  }
  const decide = latest.markers.find((marker) => marker.kind === 'decide')
  if (decide) {
    return pause('agent-decide', decide.text)
  }
  const capped = capPause(loop, state)
  if (capped) {
    return capped
  }
  if (loop.noProgress && isNoProgress(history, latest)) {
    return pause('no-progress')
  }
  const { usageLimit } = latest
  if (usageLimit) {
    if (loop.resumeAtLimitReset && usageLimit.resetsAt !== null) {
      return usageLimit.resetsAt > now
        ? { kind: 'wait', until: usageLimit.resetsAt, reason: 'limit-reset' }
        : null
    }
    return pause('usage-limit', usageLimit.provider)
  }
  return null
}

function resolveNextPrompt(
  input: DecideNextInput
): { promptSource: 'repeat' | { queueItemId: string } } | { exhausted: true } {
  const { promptSource } = input.loop
  if (promptSource.kind === 'repeat') {
    return { promptSource: 'repeat' }
  }
  const items = [...(input.queue ?? [])].sort((a, b) => a.position - b.position)
  const next = items.find((item) => item.state === 'pending')
  if (next) {
    return { promptSource: { queueItemId: next.id } }
  }
  const first = items[0]
  if (promptSource.repeatQueue && first) {
    return { promptSource: { queueItemId: first.id } }
  }
  return { exhausted: true }
}

function pacingWait(input: DecideNextInput): LoopAction | null {
  const { pacing } = input.loop
  const { state, now } = input
  if (pacing.kind !== 'interval') {
    return null
  }
  const until =
    pacing.anchor === 'wall-clock'
      ? state.nextWallClockTickAt
      : state.lastIterationEndedAt === null
        ? null
        : state.lastIterationEndedAt + pacing.minutes * MS_PER_MINUTE
  return until !== null && until > now ? { kind: 'wait', until, reason: 'pacing' } : null
}

function holdWait(hold: HoldSignals): LoopAction | null {
  if (hold.userTyping) {
    return { kind: 'wait', until: 'user-idle', reason: 'user-typing' }
  }
  if (hold.awaitingApproval) {
    return { kind: 'wait', until: 'agent-idle', reason: 'agent-busy' }
  }
  return null
}

function settlementOutcome(latest: IterationEvidence, input: DecideNextInput): LoopAction | null {
  if (latest.endReason === 'crashed' || latest.settlement === 'crashed') {
    return crashedAttemptCount(input.history, latest, input.state) >= 2
      ? pause('crashed')
      : { kind: 'retry-crashed', freshSession: true }
  }
  if (latest.endReason === 'interrupted') {
    return pause('interrupted-by-restart')
  }
  if (latest.endReason === 'stopped' || latest.settlement === 'aborted') {
    return pause('user')
  }
  if (latest.settlement === 'unverifiable') {
    return { kind: 'wait', until: 'agent-idle', reason: 'unverifiable' }
  }
  return null
}

/**
 * Chooses what the loop does after an iteration (or at start when `latest` is null). Pure and
 * total: the same input always yields the same action and nothing here reads a clock or does IO.
 * Rules are checked in precedence order: stop/pause holds, connection, crash handling, completion,
 * protected paths, markers, caps, no-progress, usage limit, queue, ask-before-next, then pacing and
 * holds before the next iteration starts.
 */
export function decideNext(input: DecideNextInput): LoopAction {
  const { loop, state, latest, hold } = input

  if (hold.stopRequested !== null) {
    return pause('user', 'stop-requested')
  }
  if (hold.userPaused) {
    return pause('user')
  }
  if (hold.connection === 'unverifiable') {
    return { kind: 'wait', until: 'agent-idle', reason: 'unverifiable' }
  }

  if (latest) {
    const outcome = settlementOutcome(latest, input)
    if (outcome) {
      return outcome
    }
    if (doneSignalsPassed(loop.done, latest)) {
      return { kind: 'complete' }
    }
    const paused = evidencePause(input, latest)
    if (paused) {
      return paused
    }
  } else {
    const capped = capPause(loop, state)
    if (capped) {
      return capped
    }
  }

  const next = resolveNextPrompt(input)
  if ('exhausted' in next) {
    return hasDoneSignal(loop.done) ? pause('queue-exhausted') : { kind: 'complete' }
  }
  if (latest && loop.askBeforeNext) {
    return pause('ask-before-next')
  }
  return (
    pacingWait(input) ??
    holdWait(hold) ?? {
      kind: 'start-iteration',
      freshSession: loop.sessionPolicy === 'fresh',
      promptSource: next.promptSource
    }
  )
}
