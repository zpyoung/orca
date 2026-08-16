// r4-3: the composer's ack'd write path (pty.ts) must be able to tell when a
// write provably went nowhere — a disposed mux drops SshPtyProvider.write's
// relay notify silently, so it needs a real signal beyond write()'s void return.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SshPtyProvider } from './ssh-pty-provider'

type MockMultiplexer = {
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  onNotification: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  isDisposed: ReturnType<typeof vi.fn>
}

function createMockMux(): MockMultiplexer {
  return {
    request: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    onNotification: vi.fn(),
    dispose: vi.fn(),
    isDisposed: vi.fn().mockReturnValue(false)
  }
}

describe('SshPtyProvider.isWriteChannelLive', () => {
  let mux: MockMultiplexer
  let provider: SshPtyProvider
  const scopedPty1 = 'ssh:conn-1@@pty-1'

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshPtyProvider('conn-1', mux as never)
  })

  it('reports the write channel live while the mux is connected', () => {
    expect(provider.isWriteChannelLive(scopedPty1)).toBe(true)
  })

  it('reports the write channel not live once the mux is disposed', () => {
    mux.isDisposed.mockReturnValue(true)
    expect(provider.isWriteChannelLive(scopedPty1)).toBe(false)
    // write() itself stays fire-and-forget — a disposed mux must not throw into it.
    expect(() => provider.write(scopedPty1, 'hello')).not.toThrow()
  })
})
