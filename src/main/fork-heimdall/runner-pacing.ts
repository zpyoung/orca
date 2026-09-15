import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import { derivePacing } from '../../shared/fork-heimdall/pacing'
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
    lastFullResyncAtMs: runner.lastFullResyncAtMs,
    evaluatedAtMs: nowMs
  })
  trace.pacing = pacing
  return pacing.delayMs === null ? null : Math.min(pacing.delayMs, pacing.nextFullResyncInMs)
}
