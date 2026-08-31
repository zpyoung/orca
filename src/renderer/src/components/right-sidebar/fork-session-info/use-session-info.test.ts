import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import type { SessionInfoPaneTelemetry } from '../../../../../shared/fork-session-info/session-info-types'
import type { ProviderRateLimits } from '../../../../../shared/rate-limit-types'
import { getCorrelatedPlanWindows } from './use-session-info'

const NOW = 100_000
const status = {
  paneKey: 'tab:00000000-0000-4000-8000-000000000001',
  state: 'working',
  prompt: '',
  stateHistory: [],
  updatedAt: NOW,
  stateStartedAt: NOW,
  agentType: 'claude',
  connectionId: null,
  providerSession: { key: 'session_id', id: 'session-1' }
} as AgentStatusEntry
const telemetry: SessionInfoPaneTelemetry = {
  paneKey: status.paneKey,
  provider: 'claude',
  providerSessionId: 'session-1',
  context: { usedPercentage: 30, updatedAt: NOW },
  planWindowsAcceptedAt: NOW,
  updatedAt: NOW
}
const limits: ProviderRateLimits = {
  provider: 'claude',
  session: { usedPercent: 10, windowMinutes: 300, resetsAt: null, resetDescription: null },
  weekly: { usedPercent: 20, windowMinutes: 10080, resetsAt: null, resetDescription: null },
  updatedAt: NOW + 1_000,
  error: null,
  status: 'ok',
  usageMetadata: { source: 'live-session' }
}
const target = { runtime: 'host', wslDistro: null } as const

describe('getCorrelatedPlanWindows', () => {
  it('uses only a recent live-session update for the same provider session', () => {
    expect(
      getCorrelatedPlanWindows({ status, telemetry, limits, target, localTelemetryAvailable: true })
    ).toMatchObject({
      fiveHour: limits.session,
      sevenDay: limits.weekly
    })
  })

  it('rejects telemetry that was not accepted for the selected account', () => {
    const { planWindowsAcceptedAt: _acceptedAt, ...uncorrelated } = telemetry
    expect(
      getCorrelatedPlanWindows({
        status,
        telemetry: uncorrelated,
        limits,
        target,
        localTelemetryAvailable: true
      })
    ).toBeUndefined()
  })

  it('rejects another provider session', () => {
    expect(
      getCorrelatedPlanWindows({
        status,
        telemetry: { ...telemetry, providerSessionId: 'session-2' },
        limits,
        target,
        localTelemetryAvailable: true
      })
    ).toBeUndefined()
  })

  it('rejects local plan windows for a runtime-hosted pane', () => {
    expect(
      getCorrelatedPlanWindows({
        status,
        telemetry,
        limits,
        target,
        localTelemetryAvailable: false
      })
    ).toBeUndefined()
  })

  it('rejects stale, polled, and remote plan windows', () => {
    expect(
      getCorrelatedPlanWindows({
        status,
        telemetry,
        limits: { ...limits, updatedAt: NOW + 31_000 },
        target,
        localTelemetryAvailable: true
      })
    ).toBeUndefined()
    expect(
      getCorrelatedPlanWindows({
        status,
        telemetry,
        limits: { ...limits, usageMetadata: { source: 'oauth' } },
        target,
        localTelemetryAvailable: true
      })
    ).toBeUndefined()
    expect(
      getCorrelatedPlanWindows({
        status: { ...status, connectionId: 'ssh-1' },
        telemetry,
        limits,
        target,
        localTelemetryAvailable: true
      })
    ).toBeUndefined()
  })
})
