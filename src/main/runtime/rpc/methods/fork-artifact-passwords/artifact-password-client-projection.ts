import type { ArtifactCloudOperation, ArtifactListPage } from '../../../../../shared/artifacts'
import type { OrcaRuntimeService } from '../../../orca-runtime'

/** Lists artifacts while removing desktop-only metadata for paired clients. */
export async function listArtifactsForClient(
  runtime: OrcaRuntimeService,
  params: { apiUrl?: string; authToken?: string; cursor?: string },
  clientKind: 'mobile' | 'runtime' | undefined
): Promise<ArtifactCloudOperation<ArtifactListPage>> {
  return projectArtifactListForClient(await runtime.listArtifacts(params), clientKind)
}

/** Projects local artifact overlays into a non-secret unknown state for paired clients. */
export function projectArtifactListForClient(
  operation: ArtifactCloudOperation<ArtifactListPage>,
  clientKind: 'mobile' | 'runtime' | undefined
): ArtifactCloudOperation<ArtifactListPage> {
  if (clientKind === undefined || operation.status !== 'ok') {
    return operation
  }
  return {
    ...operation,
    value: {
      ...operation.value,
      artifacts: operation.value.artifacts.map(({ artifact, shareUrl, local, protection }) => ({
        artifact,
        shareUrl,
        ...(local || protection ? { protection: { state: 'unknown' as const } } : {})
      }))
    }
  }
}
