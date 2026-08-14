import { describe, expect, it } from 'vitest'
import { updateTerminalDockRawRecoveryPhaseByPaneId } from './terminal-pane-dock-recovery-phase'

describe('updateTerminalDockRawRecoveryPhaseByPaneId', () => {
  it.each(['connecting', 'offline', 'ended', 'disposed'] as const)(
    'keeps the %s phase, unlike the recovery banner filter which drops it',
    (phase) => {
      const next = updateTerminalDockRawRecoveryPhaseByPaneId({}, 7, {
        phase,
        epoch: 1,
        attempt: 0
      })
      expect(next[7]).toBe(phase)
    }
  )

  it('clears a pane entry when the state goes null', () => {
    const withPhase = updateTerminalDockRawRecoveryPhaseByPaneId({}, 7, {
      phase: 'offline',
      epoch: 1,
      attempt: 0
    })
    expect(updateTerminalDockRawRecoveryPhaseByPaneId(withPhase, 7, null)).toEqual({})
  })

  it('returns the same reference when the phase does not change', () => {
    const withPhase = updateTerminalDockRawRecoveryPhaseByPaneId({}, 7, {
      phase: 'offline',
      epoch: 1,
      attempt: 0
    })
    expect(
      updateTerminalDockRawRecoveryPhaseByPaneId(withPhase, 7, {
        phase: 'offline',
        epoch: 2,
        attempt: 3
      })
    ).toBe(withPhase)
  })
})
