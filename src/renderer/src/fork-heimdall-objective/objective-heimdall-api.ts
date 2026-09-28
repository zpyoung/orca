import type { HeimdallApi } from '../../../shared/fork-heimdall/api'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isHeimdallApiBridge(value: Record<string, unknown>): value is HeimdallApi {
  return typeof value.enroll === 'function' && typeof value.onFleetChanged === 'function'
}

export function getObjectiveHeimdallApi(): HeimdallApi | null {
  const candidate: unknown = window.api?.heimdall
  if (!isRecord(candidate)) {
    return null
  }
  return isHeimdallApiBridge(candidate) ? candidate : null
}

export function describeObjectiveError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isObjectiveDetailUnavailableError(error: unknown): boolean {
  const message = describeObjectiveError(error)
  return /unknown[ _-]?method|method[ _-]?not[ _-]?found|no handler|not registered/iu.test(message)
}
