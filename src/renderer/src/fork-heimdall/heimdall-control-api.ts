import type { HeimdallApi } from '../../../shared/fork-heimdall/api'

export type HeimdallControlApi = Pick<
  HeimdallApi,
  'fleet' | 'detail' | 'command' | 'debugReport' | 'onFleetChanged'
>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isHeimdallControlApiBridge(value: Record<string, unknown>): value is HeimdallControlApi {
  return (
    typeof value.fleet === 'function' &&
    typeof value.detail === 'function' &&
    typeof value.command === 'function' &&
    typeof value.debugReport === 'function' &&
    typeof value.onFleetChanged === 'function'
  )
}

export function getHeimdallControlApi(): HeimdallControlApi | null {
  const candidate: unknown = window.api?.heimdall
  if (!isRecord(candidate)) {
    return null
  }
  return isHeimdallControlApiBridge(candidate) ? candidate : null
}
