import type { LedgerOrigin, LedgerTarget } from '../../../../shared/ledger'
import type { GlobalSettings } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

export type LedgerPanelScope = { target: LedgerTarget; environmentId?: string }

export function getLedgerPanelScope(
  activeWorktreeId: string | null,
  runtimeSettings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
): LedgerPanelScope | null {
  if (!activeWorktreeId) {
    return null
  }
  const environmentId = runtimeSettings.activeRuntimeEnvironmentId
  return {
    target: { workspaceId: activeWorktreeId },
    ...(environmentId ? { environmentId } : {})
  }
}

export function isLedgerEntryFiledHere(origin: LedgerOrigin, workspaceId: string | null): boolean {
  if (!workspaceId || !origin.workspaceId) {
    return false
  }
  if (workspaceId === origin.workspaceId) {
    return true
  }
  if (!workspaceId.startsWith('folder:') && !origin.workspaceId.startsWith('folder:')) {
    return false
  }
  const normalize = (id: string) => folderWorkspaceKey(id.startsWith('folder:') ? id.slice(7) : id)
  return normalize(workspaceId) === normalize(origin.workspaceId)
}
