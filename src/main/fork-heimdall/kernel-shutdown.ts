import type { HeimdallDatabase } from './database'
import type { HeimdallKernelHost } from './kernel-host'
import { requireLeaseStore } from './kernel-service-dependencies'
import type { LeaseStore } from './lease-store'
import type { WatcherRunnerLoop } from './runner-loop'
import type { WatcherRunner } from './runner-state'

export type KernelShutdownInput = {
  loaded: boolean
  listeners: Set<() => void>
  subscribers: Set<() => void>
  runners: Iterable<WatcherRunner>
  runnerLoop: WatcherRunnerLoop | null
  leaseStore: LeaseStore | null
  host: HeimdallKernelHost | null
  unsubscribeLedger: (() => void) | null
  database: HeimdallDatabase | null
}

/** Runs Electron's synchronous kernel shutdown barrier. */
export function shutdownHeimdallKernel(input: KernelShutdownInput): void {
  for (const listener of input.listeners) {
    try {
      listener()
    } catch (error) {
      console.warn('[heimdall] shutdown listener failed:', error)
    }
  }
  input.listeners.clear()
  input.subscribers.clear()
  if (!input.loaded) {
    return
  }

  try {
    if (!input.runnerLoop) {
      throw new Error('Heimdall runner is unavailable')
    }
    for (const runner of input.runners) {
      const guard = runner.leaseGuard
      input.runnerLoop.stop(runner)
      if (guard) {
        void requireLeaseStore(input.leaseStore)
          .release(runner.enrollment.workspaceKey, guard.epoch)
          .catch(() => {})
      }
    }
    input.host?.detachPowerMonitor()
    input.unsubscribeLedger?.()
    input.database?.close()
  } catch (error) {
    console.warn('[heimdall] shutdown teardown failed:', error)
  }
}
