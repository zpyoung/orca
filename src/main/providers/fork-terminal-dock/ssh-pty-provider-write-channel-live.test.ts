// r5-4: the composer's ack'd write path (pty.ts) must know whether a frame
// actually settled on the relay transport, not just whether the mux is
// disposed — a frame retained under backpressure and dropped by writer
// disposal must resolve the ack false.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshPtyProvider } from '../ssh-pty-provider'

type SettledCallback = (result: { ok: true } | { ok: false; error: Error }) => void

type MockMultiplexer = {
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  notifyWithSettlement: ReturnType<typeof vi.fn>
  onNotification: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  isDisposed: ReturnType<typeof vi.fn>
}

function createMockMux(): MockMultiplexer {
  return {
    request: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    notifyWithSettlement: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
}

describe('SshPtyProvider.writeAcknowledged', () => {
  let mux: MockMultiplexer
  let provider: SshPtyProvider
  const scopedPty1 = 'ssh:conn-1@@pty-1'

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshPtyProvider('conn-1', mux as never)
  })

  it('resolves true once the transport settles the frame', async () => {
    mux.notifyWithSettlement.mockImplementation(
      (_method: string, _params: unknown, onSettled: SettledCallback) => {
        onSettled({ ok: true })
      }
    )
    await expect(provider.writeAcknowledged(scopedPty1, 'hello')).resolves.toBe(true)
    expect(mux.notifyWithSettlement).toHaveBeenCalledWith(
      'pty.data',
      { id: 'pty-1', data: 'hello' },
      expect.any(Function)
    )
  })

  it('resolves false when writer disposal drops the frame before drain', async () => {
    mux.notifyWithSettlement.mockImplementation(
      (_method: string, _params: unknown, onSettled: SettledCallback) => {
        onSettled({ ok: false, error: new Error('Multiplexer writer disposed') })
      }
    )
    await expect(provider.writeAcknowledged(scopedPty1, 'hello')).resolves.toBe(false)
  })

  it('resolves false when the bounded queue rejects the frame under backpressure', async () => {
    mux.notifyWithSettlement.mockImplementation(
      (_method: string, _params: unknown, onSettled: SettledCallback) => {
        onSettled({
          ok: false,
          error: new Error('Multiplexer ordinary write queue exceeded its bounded capacity')
        })
      }
    )
    await expect(provider.writeAcknowledged(scopedPty1, 'hello')).resolves.toBe(false)
  })

  it('leaves write() fire-and-forget with no settlement plumbing', () => {
    provider.write(scopedPty1, 'hello')
    expect(mux.notify).toHaveBeenCalledWith('pty.data', { id: 'pty-1', data: 'hello' })
    expect(mux.notifyWithSettlement).not.toHaveBeenCalled()
  })
})
