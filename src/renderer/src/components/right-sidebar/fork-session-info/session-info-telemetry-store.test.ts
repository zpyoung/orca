import { describe, expect, it } from 'vitest'
import type { SessionInfoPaneTelemetry } from '../../../../../shared/fork-session-info/session-info-types'
import { reconcilePulledSessionInfoTelemetry } from './session-info-telemetry-store'

function telemetry(paneKey: string, updatedAt: number): SessionInfoPaneTelemetry {
  return { paneKey, provider: 'claude', updatedAt }
}

describe('reconcilePulledSessionInfoTelemetry', () => {
  it('removes a cached pane that disappeared while the panel was unsubscribed', () => {
    const current = { pane: telemetry('pane', 1) }
    expect(reconcilePulledSessionInfoTelemetry(current, {}, new Map(), new Map())).toEqual({})
  })

  it('keeps a push that arrived after the pull started', () => {
    const pushed = telemetry('pane', 2)
    expect(
      reconcilePulledSessionInfoTelemetry(
        { pane: pushed },
        {},
        new Map([['pane', 2]]),
        new Map([['pane', 1]])
      )
    ).toEqual({ pane: pushed })
  })

  it('lets an unchanged pull replace an older cached value', () => {
    const pulled = telemetry('pane', 2)
    expect(
      reconcilePulledSessionInfoTelemetry(
        { pane: telemetry('pane', 1) },
        { pane: pulled },
        new Map([['pane', 1]]),
        new Map([['pane', 1]])
      )
    ).toEqual({ pane: pulled })
  })
})
