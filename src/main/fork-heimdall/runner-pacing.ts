import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import { derivePacing, HEIMDALL_RAPID_POLL_MS } from '../../shared/fork-heimdall/pacing'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherTickTrace } from '../../shared/fork-heimdall/tick-trace'
import type { WatcherRunner } from './runner-state'

export function runnerPacingDelay(
  runner: WatcherRunner,
  snapshot: Snapshot<unknown>,
  ledger: WatcherLedger,
  trace: WatcherTickTrace,
  nowMs: number
): number | null {
  const tier = runner.kind.pacing?.pace(snapshot, ledger) ?? 'idle'
  const pacing = derivePacing(tier, {
    consecutiveErrors: runner.consecutiveErrors,
    consecutiveGateHolds: runner.consecutiveGateHolds,
    lastFullResyncAtMs: runner.lastFullResyncAtMs,
    evaluatedAtMs: nowMs
  })
  trace.pacing = pacing
  if (pacing.delayMs === null) {
    return null
  }
  const delayMs = Math.min(pacing.delayMs, pacing.nextFullResyncInMs)
  const idleRecheckAtMs = runner.idleRecheckAtMs ?? null
  return idleRecheckAtMs === null
    ? delayMs
    : Math.min(delayMs, HEIMDALL_RAPID_POLL_MS, Math.max(0, idleRecheckAtMs - nowMs))
}
