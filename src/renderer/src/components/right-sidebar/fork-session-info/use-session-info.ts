import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { useShallow } from 'zustand/react/shallow'
import { buildSessionInfo } from '../../../../../shared/fork-session-info'
import type {
  SessionInfo,
  SessionInfoAdapterInput,
  SessionInfoPaneTelemetry
} from '../../../../../shared/fork-session-info/session-info-types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status-types'
import type {
  ProviderRateLimits,
  RateLimitRuntimeTarget
} from '../../../../../shared/rate-limit-types'
import { useSessionInfoTelemetry } from './session-info-telemetry-store'

const PLAN_WINDOW_CORRELATION_MS = 30_000

type PlanWindows = NonNullable<SessionInfoAdapterInput['planWindows']>

export function getCorrelatedPlanWindows({
  status,
  telemetry,
  limits,
  target,
  localTelemetryAvailable
}: {
  status: AgentStatusEntry
  telemetry: SessionInfoPaneTelemetry | undefined
  limits: ProviderRateLimits | null
  target: RateLimitRuntimeTarget
  localTelemetryAvailable: boolean
}): PlanWindows | undefined {
  if (
    !localTelemetryAvailable ||
    status.agentType !== 'claude' ||
    status.connectionId ||
    target.runtime !== 'host' ||
    !telemetry ||
    telemetry.provider !== 'claude' ||
    !status.providerSession?.id ||
    telemetry.providerSessionId !== status.providerSession.id ||
    !limits ||
    limits.status !== 'ok' ||
    limits.usageMetadata?.source !== 'live-session'
  ) {
    return undefined
  }
  if (
    telemetry.planWindowsAcceptedAt === undefined ||
    Math.abs(limits.updatedAt - telemetry.planWindowsAcceptedAt) > PLAN_WINDOW_CORRELATION_MS
  ) {
    return undefined
  }
  return {
    fiveHour: limits.session,
    sevenDay: limits.weekly,
    updatedAt: limits.updatedAt
  }
}

export function useSessionInfo(
  paneKey: string | null,
  status: AgentStatusEntry | null,
  localTelemetryAvailable: boolean
): SessionInfo | null {
  const telemetry = useSessionInfoTelemetry(paneKey)
  const { claudeLimits, claudeTarget } = useAppStore(
    useShallow((state) => ({
      claudeLimits: state.rateLimits.claude,
      claudeTarget: state.rateLimits.claudeTarget
    }))
  )
  return useMemo(() => {
    if (!paneKey || !status) {
      return null
    }
    const planWindows = getCorrelatedPlanWindows({
      status,
      telemetry,
      limits: claudeLimits,
      target: claudeTarget,
      localTelemetryAvailable
    })
    return buildSessionInfo({
      paneKey,
      status,
      telemetry,
      localTelemetryAvailable,
      planWindows
    })
  }, [claudeLimits, claudeTarget, localTelemetryAvailable, paneKey, status, telemetry])
}
