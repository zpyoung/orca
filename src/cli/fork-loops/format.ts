import type { LoopSnapshot } from '../../shared/fork-loops/loop-types'

function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 60) {
    return `${totalMinutes}m`
  }
  return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`
}

export function formatLoopStatus(loop: LoopSnapshot): string {
  return loop.state === 'paused' && loop.pauseReason !== undefined
    ? `paused: ${loop.pauseReason}`
    : loop.state
}

function formatIterations(loop: LoopSnapshot): string {
  const max = loop.config.caps.maxIterations
  return max === undefined ? `${loop.iterationsCompleted}` : `${loop.iterationsCompleted}/${max}`
}

export function formatLoopList(loops: LoopSnapshot[]): string {
  if (loops.length === 0) {
    return 'No loops.'
  }
  return loops
    .map(
      (loop) =>
        `${loop.id}  ${loop.name}  ${loop.preset}  ${loop.agent}  ${formatLoopStatus(loop)}  iterations ${formatIterations(loop)}`
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
    lines.push(`Warning: ${warning}`)
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

export function formatLoopChange(verb: string, loop: LoopSnapshot): string {
  return `${verb} loop ${loop.id} (${loop.name}): ${formatLoopStatus(loop)}.`
}
