import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import { verifyPtyStopped } from './pipeline-driver-verified-stop'

function runtimeStub(overrides: Partial<OrcaRuntimeService> = {}): OrcaRuntimeService {
  return {
    waitForLeafPtyId: vi.fn().mockResolvedValue('pty-1'),
    stopExactTerminalsForWorktree: vi.fn().mockResolvedValue({
      stopped: 1,
      stoppedPtyIds: ['pty-1'],
      livePtyIds: [],
      postStopVerified: true
    }),
    ...overrides
  } as unknown as OrcaRuntimeService
}

describe('verifyPtyStopped', () => {
  it('confirms only when stopAndWait (via stopExactTerminalsForWorktree) verifies the stop', async () => {
    const runtime = runtimeStub()
    const result = await verifyPtyStopped(runtime, { worktreeId: 'wt-1', terminalHandle: 'term-1' })
    expect(result).toBe(true)
    expect(runtime.waitForLeafPtyId).toHaveBeenCalledWith('term-1', expect.any(Number))
    expect(runtime.stopExactTerminalsForWorktree).toHaveBeenCalledWith('id:wt-1', ['pty-1'], {
      targetOnly: true
    })
  })

  it('is unconfirmed when the stop resolves but is not verified (stopAndWait returned false)', async () => {
    const runtime = runtimeStub({
      stopExactTerminalsForWorktree: vi.fn().mockResolvedValue({
        stopped: 0,
        stoppedPtyIds: [],
        livePtyIds: ['pty-1'],
        postStopVerified: false
      })
    })
    const result = await verifyPtyStopped(runtime, { worktreeId: 'wt-1', terminalHandle: 'term-1' })
    expect(result).toBe(false)
  })

  it('is unconfirmed when the stop call throws (e.g. stopAndWait absent on the controller)', async () => {
    const runtime = runtimeStub({
      stopExactTerminalsForWorktree: vi
        .fn()
        .mockRejectedValue(new Error('terminal_exact_stop_unavailable'))
    })
    const result = await verifyPtyStopped(runtime, { worktreeId: 'wt-1', terminalHandle: 'term-1' })
    expect(result).toBe(false)
  })

  it('is unconfirmed when the terminal handle cannot be resolved to a live pty at all', async () => {
    const runtime = runtimeStub({
      waitForLeafPtyId: vi.fn().mockRejectedValue(new Error('handle not found'))
    })
    const result = await verifyPtyStopped(runtime, { worktreeId: 'wt-1', terminalHandle: 'term-1' })
    expect(result).toBe(false)
    expect(runtime.stopExactTerminalsForWorktree).not.toHaveBeenCalled()
  })
})
