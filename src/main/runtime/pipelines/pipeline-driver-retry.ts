/** Re-dispatch eligibility for a failed attempt: either a direct retry, or the stop-flow bridge. */

import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from '../orchestration/db'
import { verifyPtyStopped } from './pipeline-driver-verified-stop'

export type PipelineRetryPreparation = { ok: true; retryOf: string } | { ok: false; reason: string }

/**
 * Route 1 (`failWorkerStart` / `settleWorkerReport` failure): the DB already landed on
 * (worker failed, task failed), so `retryOf` is eligible without any stop-flow call — but the
 * driver's own one-live-agent invariant still requires a verified stop before reusing the
 * worktree, independent of that DB eligibility.
 */
export async function prepareDirectRetry(args: {
  runtime: OrcaRuntimeService
  worktreeId: string
  dispatchId: string
  terminalHandle?: string
}): Promise<PipelineRetryPreparation> {
  if (args.terminalHandle) {
    const stopped = await verifyPtyStopped(args.runtime, {
      worktreeId: args.worktreeId,
      terminalHandle: args.terminalHandle
    })
    if (!stopped) {
      return { ok: false, reason: "Could not confirm the failed attempt's terminal had stopped." }
    }
  }
  return { ok: true, retryOf: args.dispatchId }
}

/**
 * Route 2 (stage U, `markWorkerStartUnknown`): (start_unknown, blocked) satisfies neither the
 * retry nor the plain-dispatch precondition, so `beginWorkerStop` → verified stop →
 * `settleWorkerStop` bridges it to (stopped, blocked), which `retryOf` does accept. The close
 * step is vacuous when no terminal was ever created (stage-U resolving to B).
 */
export async function prepareBridgedRetry(args: {
  db: OrchestrationDb
  runtime: OrcaRuntimeService
  worktreeId: string
  dispatchId: string
  terminalHandle?: string
}): Promise<PipelineRetryPreparation> {
  const begun = args.db.beginWorkerStop(args.dispatchId)
  if (begun.disposition === 'stopping') {
    if (args.terminalHandle) {
      const stopped = await verifyPtyStopped(args.runtime, {
        worktreeId: args.worktreeId,
        terminalHandle: args.terminalHandle
      })
      if (!stopped) {
        return {
          ok: false,
          reason: "Could not confirm the unresolved attempt's terminal had stopped."
        }
      }
    }
    args.db.settleWorkerStop(args.dispatchId)
  }
  return { ok: true, retryOf: args.dispatchId }
}
