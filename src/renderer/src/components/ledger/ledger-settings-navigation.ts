import type { LedgerOwner } from '../../../../shared/ledger'
import type { Repo } from '../../../../shared/types'
import { getProjectIdentityKey } from '../../../../shared/project-host-setup-projection'
import type { SettingsNavigationTarget } from '@/lib/settings-navigation-types'
import { getRepositoryLedgerSectionId } from '../settings/repository-settings-targets'

/** Only a project ledger has a project settings pane; a group ledger has no such home. */
export function getLedgerSettingsNavigation(
  owner: LedgerOwner | null,
  repos: readonly Repo[]
): SettingsNavigationTarget | null {
  if (owner?.tier !== 'project') {
    return null
  }
  const repo = repos.find((item) => getProjectIdentityKey(item) === owner.id)
  if (!repo) {
    return null
  }
  return { pane: 'repo', repoId: repo.id, sectionId: getRepositoryLedgerSectionId(repo.id) }
}
