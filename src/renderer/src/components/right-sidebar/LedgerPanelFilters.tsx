import { ListFilter } from 'lucide-react'
import type { LedgerEntryType, LedgerFilters, LedgerState } from '../../../../shared/ledger'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ledgerPanelStateLabel, ledgerPanelTypeLabel } from './LedgerPanelRow'

export function LedgerPanelFilters({
  filters,
  onChange
}: {
  filters: LedgerFilters
  onChange: (filters: LedgerFilters) => void
}): React.JSX.Element {
  const booleanValue = (value: boolean | undefined) => (value === undefined ? 'all' : String(value))
  const updateBoolean = (key: 'reviewed' | 'stale', value: string) =>
    onChange({ ...filters, [key]: value === 'all' ? undefined : value === 'true' })
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="xs">
          <ListFilter />
          {translate('ledger.panel.filters', 'Filters')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-96 overflow-y-auto scrollbar-sleek">
        <DropdownMenuLabel>{translate('ledger.panel.typeLabel', 'Type')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filters.type ?? 'all'}
          onValueChange={(value) =>
            onChange({ ...filters, type: value === 'all' ? undefined : (value as LedgerEntryType) })
          }
        >
          <DropdownMenuRadioItem value="all">
            {translate('ledger.panel.allTypes', 'All types')}
          </DropdownMenuRadioItem>
          {(['bug', 'deferred', 'test-gap', 'proposal', 'decision'] as const).map((type) => (
            <DropdownMenuRadioItem key={type} value={type}>
              {ledgerPanelTypeLabel(type)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{translate('ledger.panel.stateLabel', 'State')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filters.state ?? 'all'}
          onValueChange={(value) =>
            onChange({ ...filters, state: value === 'all' ? undefined : (value as LedgerState) })
          }
        >
          <DropdownMenuRadioItem value="all">
            {translate('ledger.panel.allStates', 'All states')}
          </DropdownMenuRadioItem>
          {(['open', 'resolved', 'archived'] as const).map((state) => (
            <DropdownMenuRadioItem key={state} value={state}>
              {ledgerPanelStateLabel(state)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{translate('ledger.panel.review', 'Review')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={booleanValue(filters.reviewed)}
          onValueChange={(value) => updateBoolean('reviewed', value)}
        >
          <DropdownMenuRadioItem value="all">
            {translate('ledger.panel.allReviews', 'All review statuses')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="true">
            {translate('ledger.panel.reviewed', 'Reviewed')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="false">
            {translate('ledger.panel.unreviewed', 'Unreviewed')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{translate('ledger.panel.freshness', 'Freshness')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={booleanValue(filters.stale)}
          onValueChange={(value) => updateBoolean('stale', value)}
        >
          <DropdownMenuRadioItem value="all">
            {translate('ledger.panel.allFreshness', 'All entries')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="true">
            {translate('ledger.panel.stale', 'Stale')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="false">
            {translate('ledger.panel.notStale', 'Not stale')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
