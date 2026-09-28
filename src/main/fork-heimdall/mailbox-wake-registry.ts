/**
 * Lets an orchestration mailbox arrival wake the watcher that owns the run, instead of leaving it to
 * the next poll.
 *
 * This is deliberately a side observer rather than a `RuntimeMessageWaiters` registration: waiters are
 * exclusive per address, so subscribing that way would take the seat a coordinator's own
 * `orchestration check --wait` needs. It is inert until a kernel installs a resolver, because the
 * upstream entry point that calls it also runs in suites that never boot Heimdall.
 */
export type HeimdallMailboxWake = (address: string) => void

let installedWake: HeimdallMailboxWake | null = null

// heartbeat and status only refresh liveness, so waking on them would spend a tick to decide nothing.
const DECISION_CHANGING_TYPES: ReadonlySet<string> = new Set([
  'worker_done',
  'question',
  'escalation'
])

export function heimdallMailboxAddressForRun(orchestrationRunId: string): string {
  return `run:${orchestrationRunId}`
}

export function heimdallMailboxAddressForDispatch(dispatchId: string): string {
  return `dispatch:${dispatchId}`
}

export function setHeimdallMailboxWake(wake: HeimdallMailboxWake | null): void {
  installedWake = wake
}

export function notifyHeimdallMailboxArrival(address: string, messageType?: string): void {
  if (messageType !== undefined && !DECISION_CHANGING_TYPES.has(messageType)) {
    return
  }
  const wake = installedWake
  if (!wake) {
    return
  }
  try {
    wake(address)
  } catch {
    // A missed wake only costs the poll interval, so it must never fail the send that triggered it.
  }
}
