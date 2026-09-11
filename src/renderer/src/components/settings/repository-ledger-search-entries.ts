import type { Repo } from '../../../../shared/repo-types'
import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

export function getRepositoryLedgerSearchEntries(repo: Repo): SettingsSearchEntry[] {
  return [
    {
      title: translate('settings.repository.ledger.staleTitle', 'Ledger Staleness'),
      description: translate(
        'settings.repository.ledger.staleDescription',
        'How many days without activity before a ledger entry is flagged stale for review.'
      ),
      keywords: [
        repo.displayName,
        ...translateSearchKeyword('settings.repository.ledger.keyword.ledger', 'ledger'),
        ...translateSearchKeyword('settings.repository.ledger.keyword.stale', 'stale'),
        ...translateSearchKeyword('settings.repository.ledger.keyword.triage', 'triage'),
        ...translateSearchKeyword('settings.repository.ledger.keyword.bug', 'bug'),
        ...translateSearchKeyword('settings.repository.ledger.keyword.deferred', 'deferred')
      ]
    }
  ]
}
