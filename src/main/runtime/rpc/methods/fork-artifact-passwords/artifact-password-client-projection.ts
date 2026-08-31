import type {
  ArtifactCloudOperation,
  ArtifactListItem,
  ArtifactListPage,
  ArtifactPublishResult,
  ArtifactPublishedLink
} from '../../../../../shared/artifacts'
import {
  isLocalArtifactPasswordCaller,
  type ArtifactPasswordCaller
} from './artifact-password-local-caller'

/** Projects local artifact overlays into a non-secret unknown state for paired clients. */
export function projectArtifactListForClient(
  operation: ArtifactCloudOperation<ArtifactListPage>,
  caller: ArtifactPasswordCaller
): ArtifactCloudOperation<ArtifactListPage> {
  if (isLocalArtifactPasswordCaller(caller) || operation.status !== 'ok') {
    return operation
  }
  return {
    ...operation,
    value: {
      ...operation.value,
      artifacts: operation.value.artifacts.map(projectItemForClient)
    }
  }
}

function projectItemForClient(item: ArtifactListItem): ArtifactListItem {
  const { artifact, shareUrl, local, protection } = item
  return {
    artifact,
    shareUrl,
    ...(local || protection ? { protection: { state: 'unknown' as const } } : {})
  }
}

/**
 * Collapses the protection overlay on a single published-link lookup.
 *
 * `artifacts.getPublishedLink` is reachable by paired clients and its result carries the same
 * protection state the list projection hides, including `rotationCleanupPending`.
 */
export function projectPublishedLinkForClient(
  operation: ArtifactCloudOperation<ArtifactPublishedLink | null>,
  caller: ArtifactPasswordCaller
): ArtifactCloudOperation<ArtifactPublishedLink | null> {
  if (isLocalArtifactPasswordCaller(caller) || operation.status !== 'ok' || !operation.value) {
    return operation
  }
  const { shareUrl, protection } = operation.value
  return {
    ...operation,
    value: { shareUrl, ...(protection ? { protection: { state: 'unknown' as const } } : {}) }
  }
}

/** Collapses the protection overlay on a share/publish/update result. */
export function projectPublishResultForClient(
  operation: ArtifactCloudOperation<ArtifactPublishResult>,
  caller: ArtifactPasswordCaller
): ArtifactCloudOperation<ArtifactPublishResult> {
  if (isLocalArtifactPasswordCaller(caller) || operation.status !== 'ok') {
    return operation
  }
  const { change, item, protection } = operation.value
  return {
    ...operation,
    value: {
      change,
      item: projectItemForClient(item),
      ...(protection ? { protection: { state: 'unknown' as const } } : {})
    }
  }
}

/** Collapses the protection overlay on a share/update result, which returns a bare list item. */
export function projectListItemForClient(
  operation: ArtifactCloudOperation<ArtifactListItem>,
  caller: ArtifactPasswordCaller
): ArtifactCloudOperation<ArtifactListItem> {
  if (isLocalArtifactPasswordCaller(caller) || operation.status !== 'ok') {
    return operation
  }
  return { ...operation, value: projectItemForClient(operation.value) }
}

type ProjectableMethod = {
  name: string
  handler: (params: never, context: never, ...rest: never[]) => unknown
}

const PROJECTIONS: Record<string, (result: never, caller: ArtifactPasswordCaller) => unknown> = {
  'artifacts.list': projectArtifactListForClient as never,
  'artifacts.getPublishedLink': projectPublishedLinkForClient as never,
  'artifacts.share': projectListItemForClient as never,
  'artifacts.update': projectListItemForClient as never,
  'artifacts.publish': projectPublishResultForClient as never
}

/**
 * Wraps upstream's artifact methods so every result a paired client can reach loses its local
 * overlay and protection state.
 *
 * Gating one method is not enough: the same protection state rides on the published-link lookup
 * and on every share/publish/update result, so a paired client could read from any of them.
 */
export function withArtifactProtectionProjection<TMethod extends ProjectableMethod>(
  methods: readonly TMethod[]
): readonly TMethod[] {
  return methods.map((method) => {
    const project = PROJECTIONS[method.name]
    if (!project) {
      return method
    }
    return {
      ...method,
      handler: async (params: never, context: never, ...rest: never[]) => {
        const { clientKind, clientId } = context as unknown as ArtifactPasswordCaller
        const result = await method.handler(params, context, ...rest)
        return project(result as never, { clientKind, clientId })
      }
    }
  })
}
