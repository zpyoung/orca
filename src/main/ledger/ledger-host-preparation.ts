import {
  collectLedgerImportSources,
  observeLedgerOrigin,
  type LedgerHostIo,
  type LedgerHostWorkspace
} from './ledger-host-context'
import {
  LedgerError,
  type LedgerImportSkip,
  type LedgerLocation,
  type LedgerMutationContext,
  type LedgerRequest
} from '../../shared/ledger'
import { normalizeLedgerLocation } from '../../shared/ledger-locations'

type HostPreparationOptions = {
  resolveHost?: (
    workspaceId: string
  ) => Promise<{ workspace: LedgerHostWorkspace; io: LedgerHostIo } | null>
  normalizeUiLocation?: (location: LedgerLocation) => Promise<LedgerLocation>
  detachedEntryContent?: (ledgerId: string, entryId: string) => Record<string, unknown> | undefined
}

export type PreparedLedgerHost = {
  importRecords?: LedgerMutationContext['importRecords']
  importSkips?: LedgerImportSkip[]
  origin?: LedgerMutationContext['origin']
  content?: Record<string, unknown>
}

export async function prepareLedgerHostRequest(
  request: LedgerRequest,
  options: HostPreparationOptions
): Promise<PreparedLedgerHost | undefined> {
  const workspaceId = request.target?.workspaceId
  const content = request.content ? { ...request.content } : undefined
  const shouldObserveOrigin =
    Boolean(workspaceId) && (request.operation === 'file' || request.operation === 'import')
  const shouldNormalizeContent = request.operation === 'file' || request.operation === 'edit'
  const detachedEntry =
    request.operation === 'edit' && request.target?.ledgerId && request.id
      ? options.detachedEntryContent?.(request.target.ledgerId, request.id)
      : undefined
  const unchangedLocation = (key: string, value: unknown): boolean =>
    Boolean(
      detachedEntry &&
      isStructuredLocation(value) &&
      JSON.stringify(value) === JSON.stringify(detachedEntry[key])
    )
  if (!workspaceId && shouldNormalizeContent) {
    const locations = ['file', 'file_under_test']
      .map((key) => ({ key, value: content?.[key] }))
      .filter(({ value }) => value !== undefined)
    if (locations.some(({ value }) => typeof value === 'string')) {
      throw new LedgerError(
        'invalid-target',
        'A workspace target is required for raw location scope'
      )
    }
    for (const { key, value } of locations) {
      if (!isStructuredLocation(value) || unchangedLocation(key, value)) {
        continue
      }
      if (!options.normalizeUiLocation) {
        throw new LedgerError('workspace-missing', 'Location normalization is unavailable')
      }
      content![key] = await options.normalizeUiLocation(value)
    }
  }
  if (!workspaceId || !options.resolveHost) {
    return content ? { content } : undefined
  }
  const resolved = await options.resolveHost(workspaceId)
  if (!resolved) {
    throw new LedgerError('workspace-missing', 'Workspace host is unavailable')
  }
  if (shouldNormalizeContent) {
    for (const key of ['file', 'file_under_test']) {
      const value = content?.[key]
      if (unchangedLocation(key, value)) {
        continue
      }
      if (isStructuredLocation(value)) {
        const sameBase =
          value.base.kind === 'project'
            ? value.base.id === resolved.workspace.projectId
            : value.base.id === resolved.workspace.workspaceId
        if (!sameBase) {
          if (!options.normalizeUiLocation) {
            throw new LedgerError('workspace-missing', 'Location normalization is unavailable')
          }
          content![key] = await options.normalizeUiLocation(value)
          continue
        }
        if (value.base.host && value.base.host !== resolved.workspace.host) {
          throw new LedgerError(
            'workspace-missing',
            'Location host is not available in this runtime'
          )
        }
      }
      if (typeof value === 'string' || isStructuredLocation(value)) {
        content![key] = normalizeLedgerLocation(value, {
          base: resolved.workspace.projectId
            ? { kind: 'project', id: resolved.workspace.projectId, host: resolved.workspace.host }
            : {
                kind: 'workspace',
                id: resolved.workspace.workspaceId,
                host: resolved.workspace.host
              },
          rootPath: resolved.workspace.rootPath,
          platform: resolved.workspace.platform,
          host: resolved.workspace.host
        })
      }
    }
  }
  const origin = shouldObserveOrigin
    ? await observeLedgerOrigin(resolved.workspace, resolved.io)
    : undefined
  if (request.operation === 'import') {
    const imported = await collectLedgerImportSources(resolved.workspace, resolved.io)
    return { origin, importRecords: imported.records, importSkips: imported.skipped, content }
  }
  return { ...(origin ? { origin } : {}), content }
}

function isStructuredLocation(value: unknown): value is LedgerLocation {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as { path?: unknown; base?: { kind?: unknown; id?: unknown } }
  return (
    typeof candidate.path === 'string' &&
    !!candidate.base &&
    (candidate.base.kind === 'project' || candidate.base.kind === 'workspace') &&
    typeof candidate.base.id === 'string'
  )
}
