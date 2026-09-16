import type { HeimdallDatabase } from './database'
import type { HeimdallKernelHost } from './kernel-host'
import { requireLeaseStore } from './kernel-service-dependencies'
import type { LeaseStore } from './lease-store'
import type { WatcherRunnerLoop } from './runner-loop'
import type { WatcherRunner } from './runner-state'

export type KernelShutdownInput = {
  loaded: boolean
  listeners: Set<() => void>
  drainedListeners: Set<() => void>
  subscribers: Set<() => void>
  runners: Iterable<WatcherRunner>
  runnerLoop: WatcherRunnerLoop | null
  leaseStore: LeaseStore | null
  host: HeimdallKernelHost | null
  unsubscribeLedger: (() => void) | null
  database: HeimdallDatabase | null
}

const DEFAULT_DRAIN_MS = 1_500

async function drainOperations(
  operations: Promise<unknown>[],
  deadlineAtMs: number
): Promise<void> {
  if (operations.length === 0) {
    return
  }
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadlineAtMs - Date.now()))
    timer?.unref()
  })
  await Promise.race([Promise.allSettled(operations), deadline])
  clearTimeout(timer)
}

function notifyShutdownListeners(listeners: Set<() => void>): void {
  for (const listener of listeners) {
    try {
      listener()
    } catch (error) {
      console.warn('[heimdall] shutdown listener failed:', error)
    }
  }
  listeners.clear()
}

/** Stops new work, gives active ticks a bounded drain, then closes kernel storage. */
export async function shutdownHeimdallKernel(
  input: KernelShutdownInput,
  drainMs = DEFAULT_DRAIN_MS
): Promise<void> {
  input.subscribers.clear()
  notifyShutdownListeners(input.listeners)
  if (!input.loaded) {
    notifyShutdownListeners(input.drainedListeners)
    return
  }

  try {
    if (!input.runnerLoop) {
      throw new Error('Heimdall runner is unavailable')
    }
    const runners = [...input.runners]
    const deadlineAtMs = Date.now() + Math.max(0, drainMs)
    for (const runner of runners) {
      input.runnerLoop.stop(runner)
    }
    input.host?.detachPowerMonitor()
    input.unsubscribeLedger?.()
    await drainOperations(
      runners.map((runner) => runner.operationTail),
      deadlineAtMs
    )

    const releases: Promise<void>[] = []
    for (const runner of runners) {
      const guard = runner.leaseGuard
      if (!guard) {
        continue
      }
      releases.push(
        requireLeaseStore(input.leaseStore)
          .release(runner.enrollment.workspaceKey, guard.epoch)
          .catch(() => {})
          .finally(() => {
            if (runner.leaseGuard === guard) {
              runner.leaseGuard = null
            }
          })
      )
    }
    await drainOperations(releases, deadlineAtMs)
  } catch (error) {
    console.warn('[heimdall] shutdown teardown failed:', error)
  }
  notifyShutdownListeners(input.drainedListeners)
  try {
    input.database?.close()
  } catch (error) {
    console.warn('[heimdall] shutdown database close failed:', error)
  }
}
