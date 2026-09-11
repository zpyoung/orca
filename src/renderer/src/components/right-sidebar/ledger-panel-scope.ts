import type { LedgerFilters, LedgerOrigin, LedgerTarget } from '../../../../shared/ledger'
import type { GlobalSettings } from '../../../../shared/types'
import { isSameWorkspaceId } from '../../../../shared/workspace-scope'

/** Which records the panel shows: this checkout only, the whole project ledger, or the group ledger. */
export type LedgerPanelTier = 'workspace' | 'project' | 'group'

export type LedgerPanelScope = {
  workspaceId: string
  isFolderWorkspace: boolean
  hasGroup: boolean
  environmentId?: string
}

export function getLedgerPanelScope(
  activeWorkspaceId: string | null,
  runtimeSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>,
  hasGroup: boolean
): LedgerPanelScope | null {
  if (!activeWorkspaceId) {
    return null
  }
  const environmentId = runtimeSettings.activeRuntimeEnvironmentId
  return {
    workspaceId: activeWorkspaceId,
    isFolderWorkspace: activeWorkspaceId.startsWith('folder:'),
    hasGroup,
    ...(environmentId ? { environmentId } : {})
  }
}

/** A folder workspace has no project tier; its own ledger is the group's. */
export function getLedgerPanelTiers(scope: LedgerPanelScope | null): LedgerPanelTier[] {
  if (scope?.isFolderWorkspace) {
    return ['workspace', 'group']
  }
  return scope?.hasGroup ? ['workspace', 'project', 'group'] : ['workspace', 'project']
}

export function getLedgerPanelTarget(scope: LedgerPanelScope, tier: LedgerPanelTier): LedgerTarget {
  return {
    workspaceId: scope.workspaceId,
    ...(tier === 'group' ? { group: true } : {})
  }
}

/** The workspace tier reads the same ledger as its owner and narrows by filing origin. */
export function getLedgerPanelFilters(
  scope: LedgerPanelScope,
  tier: LedgerPanelTier,
  filters: LedgerFilters
): LedgerFilters {
  return tier === 'workspace' ? { ...filters, workspaceId: scope.workspaceId } : filters
}

export function isLedgerEntryFiledHere(origin: LedgerOrigin, workspaceId: string | null): boolean {
  return isSameWorkspaceId(workspaceId, origin.workspaceId)
}
