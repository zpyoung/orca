import type {
  SessionInfoPaneTelemetry,
  SessionInfoStatusLineChainStatus,
  SessionInfoTelemetrySnapshot
} from '../../../../../shared/fork-session-info/session-info-types'

export type ForkSessionInfoRendererApi = {
  getSnapshot: () => Promise<SessionInfoTelemetrySnapshot>
  onUpdate: (listener: (telemetry: SessionInfoPaneTelemetry) => void) => () => void
  getStatusLineChainStatus: () => Promise<SessionInfoStatusLineChainStatus>
  enableStatusLineChaining: () => Promise<SessionInfoStatusLineChainStatus>
}

/** Returns the optional fork API without widening the upstream preload surface. */
export function getForkSessionInfoApi(): ForkSessionInfoRendererApi | null {
  if (typeof window === 'undefined') {
    return null
  }
  return (
    (
      window.api as typeof window.api & {
        forkSessionInfo?: ForkSessionInfoRendererApi
      }
    ).forkSessionInfo ?? null
  )
}
