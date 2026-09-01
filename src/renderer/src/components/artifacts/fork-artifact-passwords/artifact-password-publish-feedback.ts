import type { ArtifactPublishResult } from '../../../../../shared/artifacts'

/** Shows success only after a protection transition has fully completed. */
export function showCompletedArtifactPublish(
  result: ArtifactPublishResult,
  show: (result: ArtifactPublishResult) => void
): void {
  if (!result.protection?.rotationCleanupPending) {
    show(result)
  }
}
