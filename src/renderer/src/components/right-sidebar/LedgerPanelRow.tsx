import type { LedgerEntry, LedgerEntryType, LedgerState } from '../../../../shared/ledger'
import { translate } from '@/i18n/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'

export function ledgerPanelTypeLabel(type: LedgerEntryType): string {
  switch (type) {
    case 'bug':
      return translate('ledger.panel.type.bug', 'Bug')
    case 'deferred':
      return translate('ledger.panel.type.deferred', 'Deferred')
    case 'test-gap':
      return translate('ledger.panel.type.testGap', 'Test gap')
    case 'proposal':
      return translate('ledger.panel.type.proposal', 'Proposal')
    case 'decision':
      return translate('ledger.panel.type.decision', 'Decision')
  }
}

export function ledgerPanelStateLabel(state: LedgerState): string {
  switch (state) {
    case 'open':
      return translate('ledger.panel.state.open', 'Open')
    case 'resolved':
      return translate('ledger.panel.state.resolved', 'Resolved')
    case 'archived':
      return translate('ledger.panel.state.archived', 'Archived')
  }
}

export function LedgerPanelRow({
  entry,
  filedHere,
  onOpen
}: {
  entry: LedgerEntry
  filedHere: boolean
  onOpen: (entry: LedgerEntry) => void
}): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      className="h-auto w-full flex-col items-start gap-1 rounded-none px-4 py-2 text-left"
      onClick={() => onOpen(entry)}
    >
      <span className="flex w-full flex-wrap items-center gap-1 text-xs">
        <span className="font-mono text-muted-foreground">{entry.id}</span>
        <Badge variant="outline">{ledgerPanelTypeLabel(entry.type)}</Badge>
        <Badge variant="secondary">{ledgerPanelStateLabel(entry.state)}</Badge>
      </span>
      <span className="w-full truncate text-sm">
        {String(entry.content.title ?? translate('ledger.panel.untitled', 'Untitled'))}
      </span>
      {filedHere ? (
        <span className="text-xs font-normal text-muted-foreground">
          {translate('ledger.panel.filedHere', 'Filed here')}
        </span>
      ) : null}
    </Button>
  )
}
