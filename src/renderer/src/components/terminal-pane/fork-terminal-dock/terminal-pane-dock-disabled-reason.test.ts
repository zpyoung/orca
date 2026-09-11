import { describe, expect, it } from 'vitest'
import { resolveTerminalDockDisabledReason } from './terminal-pane-dock-disabled-reason'

describe('resolveTerminalDockDisabledReason', () => {
  it('enables the composer when the transport is connected and unquarantined', () => {
    expect(
      resolveTerminalDockDisabledReason({
        targetPtyId: 'pty-1',
        recoveryPhase: 'connected',
        quarantined: false
      })
    ).toBeNull()
  })

  it('disables when there is no live target PTY', () => {
    expect(
      resolveTerminalDockDisabledReason({
        targetPtyId: null,
        recoveryPhase: null,
        quarantined: false
      })
    ).toBe('No terminal session')
  })

  it.each([
    ['connecting', 'Connecting…'],
    ['recovering', 'Reconnecting…'],
    ['backoff', 'Reconnecting…'],
    ['disconnected', 'Disconnected'],
    ['offline', 'Offline'],
    ['ended', 'Session ended'],
    ['disposed', 'Session ended']
  ] as const)('reflects the %s recovery phase', (phase, reason) => {
    expect(
      resolveTerminalDockDisabledReason({
        targetPtyId: 'pty-1',
        recoveryPhase: phase,
        quarantined: false
      })
    ).toBe(reason)
  })

  it('layers quarantine on top of an otherwise-live transport', () => {
    expect(
      resolveTerminalDockDisabledReason({
        targetPtyId: 'pty-1',
        recoveryPhase: 'connected',
        quarantined: true
      })
    ).toBe('Reattaching…')
  })

  it('lets a transport reason take priority over quarantine', () => {
    expect(
      resolveTerminalDockDisabledReason({
        targetPtyId: 'pty-1',
        recoveryPhase: 'recovering',
        quarantined: true
      })
    ).toBe('Reconnecting…')
  })

  it('disables with an SSH-specific reason ahead of an as-yet-unreflected PTY recovery phase', () => {
    expect(
      resolveTerminalDockDisabledReason({
        targetPtyId: 'pty-1',
        recoveryPhase: 'connected',
        quarantined: false,
        sshDisconnected: true
      })
    ).toBe('SSH disconnected')
  })

  it('does not disable for SSH when the connection is live', () => {
    expect(
      resolveTerminalDockDisabledReason({
        targetPtyId: 'pty-1',
        recoveryPhase: 'connected',
        quarantined: false,
        sshDisconnected: false
      })
    ).toBeNull()
  })

  it('disables with a lease-held reason when another client drives the PTY', () => {
    expect(
      resolveTerminalDockDisabledReason({
        targetPtyId: 'pty-1',
        recoveryPhase: 'connected',
        quarantined: false,
        mobileDriverLeaseHeld: true
      })
    ).toBe('Mobile device is composing')
  })

  it('enables when this client holds the driver lease (or there is none)', () => {
    expect(
      resolveTerminalDockDisabledReason({
        targetPtyId: 'pty-1',
        recoveryPhase: 'connected',
        quarantined: false,
        mobileDriverLeaseHeld: false
      })
    ).toBeNull()
  })

  it('lets a transport reason take priority over the driver lease', () => {
    expect(
      resolveTerminalDockDisabledReason({
        targetPtyId: 'pty-1',
        recoveryPhase: 'recovering',
        quarantined: false,
        mobileDriverLeaseHeld: true
      })
    ).toBe('Reconnecting…')
  })
})
