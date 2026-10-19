import type { LedgerFilters, LedgerOrigin, LedgerTarget } from '../../../../shared/ledger'
import { isSameWorkspaceId } from '../../../../shared/workspace-scope'

/** Which records the panel shows: this checkout only, the whole project ledger, or the group ledger. */
export type LedgerPanelTier = 'workspace' | 'project' | 'group'

export type LedgerPanelScope = {
  workspaceId: string
  isFolderWorkspace: boolean
  hasGroup: boolean
  environmentId?: string
  /** Two hosts publish this workspace, so no ledger request may pick one. */
  ownerAmbiguous?: true
}

/** Who owns the workspace: a paired server, this app (`null`), or a twin no host can claim. */
export type LedgerPanelOwner =
  | { kind: 'resolved'; environmentId: string | null }
  | { kind: 'ambiguous' }

const AMBIGUOUS_OWNER_KEY = 'ambiguous'
const LOCAL_OWNER_KEY = 'local'
const ENVIRONMENT_OWNER_KEY_PREFIX = 'env:'

/** A primitive stand-in for {@link LedgerPanelOwner} so store selectors stay referentially stable. */
export function ledgerPanelOwnerKey(owner: LedgerPanelOwner): string {
  if (owner.kind === 'ambiguous') {
    return AMBIGUOUS_OWNER_KEY
  }
  return owner.environmentId
    ? `${ENVIRONMENT_OWNER_KEY_PREFIX}${owner.environmentId}`
    : LOCAL_OWNER_KEY
}

export function ledgerPanelOwnerFromKey(key: string): LedgerPanelOwner {
  if (key === AMBIGUOUS_OWNER_KEY) {
    return { kind: 'ambiguous' }
  }
  return {
    kind: 'resolved',
    environmentId: key.startsWith(ENVIRONMENT_OWNER_KEY_PREFIX)
      ? key.slice(ENVIRONMENT_OWNER_KEY_PREFIX.length)
      : null
  }
}

export function getLedgerPanelScope(
  activeWorkspaceId: string | null,
  owner: LedgerPanelOwner,
  hasGroup: boolean
): LedgerPanelScope | null {
  if (!activeWorkspaceId) {
    return null
  }
  const base = {
    workspaceId: activeWorkspaceId,
    isFolderWorkspace: activeWorkspaceId.startsWith('folder:'),
    hasGroup
  }
  if (owner.kind === 'ambiguous') {
    return { ...base, ownerAmbiguous: true }
  }
  return { ...base, ...(owner.environmentId ? { environmentId: owner.environmentId } : {}) }
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
