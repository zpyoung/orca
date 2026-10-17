import type { LoopSnapshot } from '../../shared/fork-loops/loop-types'

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 60) {
    return `${totalMinutes}m`
  }
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`
}

export function formatLoopStatus(loop: LoopSnapshot): string {
  if (loop.unverifiableSince !== undefined) {
    return 'unverifiable'
  }
  return loop.state === 'paused' && loop.pauseReason !== undefined
    ? `paused: ${loop.pauseReason}`
    : loop.state
}

function formatIterations(loop: LoopSnapshot): string {
  const max = loop.config.caps.maxIterations
  return max === undefined ? `${loop.iterationsCompleted}` : `${loop.iterationsCompleted}/${max}`
}

function formatSkippedTicks(loop: LoopSnapshot): string {
  return `${loop.skippedTicks} ${loop.skippedTicks === 1 ? 'tick' : 'ticks'} skipped`
}

export function formatLoopList(loops: LoopSnapshot[]): string {
  if (loops.length === 0) {
    return 'No loops.'
  }
  return loops
    .map(
      (loop) =>
        `${loop.id}  ${loop.name}  ${loop.preset}  ${loop.agent}  ${formatLoopStatus(loop)}  iterations ${formatIterations(loop)}${loop.skippedTicks > 0 ? `  ${formatSkippedTicks(loop)}` : ''}`
    )
    .join('\n')
}

export function formatLoopDetail(loop: LoopSnapshot): string {
  const lines = [
    `${loop.name} (${loop.id})`,
    `Status: ${formatLoopStatus(loop)}`,
    `Preset: ${loop.preset}  Agent: ${loop.agent}  Session: ${loop.config.sessionPolicy}`,
    `Worktree: ${loop.worktreeId}`,
    `Iterations: ${formatIterations(loop)}  Active: ${formatDuration(loop.activeMs)}`
  ]
  if (loop.unverifiableSince !== undefined) {
    lines.push(
      `Host unreachable since ${new Date(loop.unverifiableSince).toISOString()}; the loop is not advancing`
    )
  }
  if (loop.skippedTicks > 0) {
    lines.push(`Ticks skipped: ${loop.skippedTicks}`)
  }
  if (loop.costUsd !== undefined) {
    lines.push(`Cost: $${loop.costUsd.toFixed(2)}`)
  }
  if (loop.pauseDetail !== undefined) {
    lines.push(`Detail: ${loop.pauseDetail}`)
  }
  if (loop.currentIteration !== undefined) {
    lines.push(`Now: iteration ${loop.currentIteration.n} ${loop.currentIteration.phase}`)
  }
  if (loop.nextIterationAt !== undefined) {
    lines.push(`Next iteration: ${new Date(loop.nextIterationAt).toISOString()}`)
  }
  if (loop.pendingQuestion !== undefined) {
    lines.push(`Agent ${loop.pendingQuestion.kind}: ${loop.pendingQuestion.text}`)
  }
  if (loop.detached) {
    lines.push('Tab: detached (no open tab)')
  }
  for (const warning of loop.warnings ?? []) {
    lines.push(`Warning: ${describeLoopWarning(warning)}`)
  }
  for (const iteration of loop.recentIterations.slice(-5)) {
    const check =
      iteration.checkPass === null
        ? 'no check'
        : iteration.checkPass
          ? 'check passed'
          : 'check failed'
    lines.push(`  #${iteration.n}  ${iteration.endReason ?? 'in progress'}  ${check}`)
  }
  return lines.join('\n')
}

const LOOP_WARNING_TEXT: Record<string, string> = {
  'worktree-has-running-loop': 'another loop is already running in this worktree'
}

function describeLoopWarning(warning: string): string {
  return LOOP_WARNING_TEXT[warning] ?? warning
}

export function formatLoopChange(verb: string, loop: LoopSnapshot): string {
  const head = `${verb} loop ${loop.id} (${loop.name}): ${formatLoopStatus(loop)}.`
  const warnings = (loop.warnings ?? []).map(
    (warning) => `Warning: ${describeLoopWarning(warning)}`
  )
  return [head, ...warnings].join('\n')
}
