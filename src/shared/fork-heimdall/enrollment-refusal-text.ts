import type { EnrollResult } from './watcher-types'

export function formatHeimdallEnrollmentRefusal(
  result: Extract<EnrollResult, { status: 'refused' }>
): string {
  const detail =
    result.reason === 'duplicate-workspace'
      ? `watcher ${result.existingWatcherId} already owns this workspace`
      : result.reason === 'owner-not-executable'
        ? `scheduler ${result.schedulerOwner} cannot execute this watcher`
        : result.detail
  return `Heimdall enrollment refused: ${result.reason}: ${detail}`
}
