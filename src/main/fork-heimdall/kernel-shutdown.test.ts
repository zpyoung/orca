import { describe, expect, it, vi } from 'vitest'
import type { HeimdallDatabase } from './database'
import type { KernelShutdownInput } from './kernel-shutdown'
import { shutdownHeimdallKernel } from './kernel-shutdown'
import type { LeaseStore } from './lease-store'
import type { WatcherRunnerLoop } from './runner-loop'
import type { WatcherRunner } from './runner-state'

function shutdownInput(
  operationTail: Promise<void>,
  close: () => void,
  release: LeaseStore['release'] = async () => {}
): KernelShutdownInput {
  const runner = {
    operationTail,
    leaseGuard: { epoch: 7 },
    enrollment: { workspaceKey: 'local::/workspace' }
  } as unknown as WatcherRunner
  return {
    loaded: true,
    listeners: new Set(),
    drainedListeners: new Set(),
    subscribers: new Set(),
    runners: [runner],
    runnerLoop: { stop: vi.fn() } as unknown as WatcherRunnerLoop,
    leaseStore: {
      acquireOrRenew: async () => ({
        status: 'refused',
        reason: 'held-by-other',
        holder: 'other',
        epoch: 7
      }),
      release
    },
    host: null,
    unsubscribeLedger: null,
    database: { close } as unknown as HeimdallDatabase
  }
}

describe('Heimdall kernel shutdown drain', () => {
  it('retains the lease while draining, then releases it before closing storage', async () => {
    let settleOperation: (() => void) | undefined
    let settleRelease: (() => void) | undefined
    const operationTail = new Promise<void>((resolve) => {
      settleOperation = resolve
    })
    const release = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleRelease = resolve
        })
    )
    const close = vi.fn()

    const input = shutdownInput(operationTail, close, release)
    const runner = [...input.runners][0]!
    const stopAcceptingWork = vi.fn()
    const disposeStorage = vi.fn()
    input.listeners.add(stopAcceptingWork)
    input.drainedListeners.add(disposeStorage)
    const shutdown = shutdownHeimdallKernel(input, 5_000)
    await Promise.resolve()
    expect(stopAcceptingWork).toHaveBeenCalledOnce()
    expect(release).not.toHaveBeenCalled()
    expect(runner.leaseGuard).not.toBeNull()
    expect(disposeStorage).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()

    settleOperation?.()
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith('local::/workspace', 7))
    expect(runner.leaseGuard).not.toBeNull()
    expect(close).not.toHaveBeenCalled()
    expect(disposeStorage).not.toHaveBeenCalled()

    settleRelease?.()
    await shutdown
    expect(runner.leaseGuard).toBeNull()
    expect(disposeStorage).toHaveBeenCalledOnce()
    expect(disposeStorage.mock.invocationCallOrder[0]!).toBeLessThan(
      close.mock.invocationCallOrder[0]!
    )
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes after the bounded deadline when an operation does not settle', async () => {
    vi.useFakeTimers()
    try {
      const close = vi.fn()
      const shutdown = shutdownHeimdallKernel(shutdownInput(new Promise<void>(() => {}), close), 25)

      await vi.advanceTimersByTimeAsync(24)
      expect(close).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await shutdown
      expect(close).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})
