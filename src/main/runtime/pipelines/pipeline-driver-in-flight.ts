/** Pure helpers for the driver's single in-flight-attempt slot: recording a spawn as soon as it can have side effects, and finding the interrupt target for it at abort. */

import type { ResolvedPipelineNode } from '../../../shared/pipeline-template-types'
import type { OrchestrationDb } from '../orchestration/db'
import { resolveVerifiableTerminalHandle } from './pipeline-driver-failure'
import type { PipelineInFlightDispatch } from './pipeline-driver-types'

/**
 * Makes an attempt abortable from the moment its process can have side effects (the durable
 * spawn receipt landing), rather than only once the whole dispatch call returns — which can run
 * to the readiness-wait timeout. Returns `undefined` when the run is already terminal, meaning
 * the caller must leave any existing in-flight record untouched.
 */
export function beginInFlightSpawn(args: {
  phase: 'running' | 'paused' | 'terminal'
  node: ResolvedPipelineNode
  taskId: string
  attempt: number
  dispatchId: string
}): PipelineInFlightDispatch | undefined {
  if (args.phase === 'terminal') {
    return undefined
  }
  return { node: args.node, taskId: args.taskId, attempt: args.attempt, dispatchId: args.dispatchId }
}

/** The durable dispatch record, not just the in-memory cache, so a just-spawned attempt is reachable before its worker-start call returns. */
export function resolveAbortInterruptHandle(
  db: OrchestrationDb,
  inFlight: Pick<PipelineInFlightDispatch, 'dispatchId' | 'terminalHandle'> | undefined
): string | undefined {
  if (!inFlight) {
    return undefined
  }
  return resolveVerifiableTerminalHandle(db, {
    dispatchId: inFlight.dispatchId,
    terminalHandle: inFlight.terminalHandle
  })
}
