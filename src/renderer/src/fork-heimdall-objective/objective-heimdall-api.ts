import type { HeimdallApi } from '../../../shared/fork-heimdall/api'

export function getObjectiveHeimdallApi(): HeimdallApi | null {
  const candidate: unknown = window.api?.heimdall
  if (!candidate || typeof candidate !== 'object') {
    return null
  }
  const methods = candidate as Partial<Record<keyof HeimdallApi, unknown>>
  return typeof methods.enroll === 'function' && typeof methods.onFleetChanged === 'function'
    ? (candidate as HeimdallApi)
    : null
}

export function describeObjectiveError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isObjectiveDetailUnavailableError(error: unknown): boolean {
  const message = describeObjectiveError(error)
  return /unknown[ _-]?method|method[ _-]?not[ _-]?found|no handler|not registered/iu.test(message)
}
