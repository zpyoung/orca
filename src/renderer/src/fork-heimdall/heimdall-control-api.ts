import type { HeimdallApi } from '../../../shared/fork-heimdall/api'

export type HeimdallControlApi = Pick<
  HeimdallApi,
  'fleet' | 'detail' | 'command' | 'onFleetChanged'
>

export function getHeimdallControlApi(): HeimdallControlApi | null {
  const candidate: unknown = window.api?.heimdall
  if (!candidate || typeof candidate !== 'object') {
    return null
  }
  const methods = candidate as Partial<Record<keyof HeimdallControlApi, unknown>>
  return typeof methods.fleet === 'function' &&
    typeof methods.detail === 'function' &&
    typeof methods.command === 'function' &&
    typeof methods.onFleetChanged === 'function'
    ? (candidate as HeimdallControlApi)
    : null
}
