import type { LedgerEntry, LedgerRequest, LedgerTarget } from '../../../../shared/ledger'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'

export type LedgerEntryListProps = {
  entries: LedgerEntry[]
  selected: Map<string, number>
  busy: boolean
  target?: LedgerTarget
  onSelect: (entry: LedgerEntry, checked: boolean) => void
  onDetail: (id: string) => void
  onEdit: (entry: LedgerEntry) => void
  onMutate: (request: LedgerRequest) => void
  onConfirm: (message: string, request: LedgerRequest) => void
}

export function LedgerEntryList({
  entries,
  selected,
  busy,
  target,
  onSelect,
  onDetail,
  onEdit,
  onMutate,
  onConfirm
}: LedgerEntryListProps): React.JSX.Element {
  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek p-6">
      <div className="grid gap-2">
        {busy && !entries.length ? (
          <p className="text-sm text-muted-foreground">
            {translate('ledger.panel.loading', 'Loading ledger…')}
          </p>
        ) : null}
        {!busy && !entries.length ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {translate('ledger.list.empty', 'No entries match these filters.')}
          </p>
        ) : null}
        {entries.map((entry) => (
          <Card key={entry.id}>
            <CardContent className="flex items-start gap-3 p-4">
              <Checkbox
                aria-label={translate('ledger.list.selectEntry', 'Select {{id}}', {
                  id: entry.id
                })}
                checked={selected.has(entry.id)}
                disabled={busy}
                onCheckedChange={(checked) => onSelect(entry, checked === true)}
              />
              <button className="min-w-0 flex-1 text-left" onClick={() => onDetail(entry.id)}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">{entry.id}</span>
                  <Badge variant="outline">{entry.type}</Badge>
                  <Badge variant="secondary">{entry.state}</Badge>
                  {entry.reviewed ? (
                    <Badge>{translate('ledger.list.reviewedBadge', 'reviewed')}</Badge>
                  ) : null}
                </div>
                <p className="mt-1 truncate text-sm">{String(entry.content.title)}</p>
                <p className="text-xs text-muted-foreground">
                  {translate('ledger.list.revisionLine', 'revision {{revision}} · {{updated}}', {
                    revision: entry.revision,
                    updated: new Date(entry.updatedAt).toLocaleString()
                  })}
                </p>
              </button>
              <div className="flex flex-wrap gap-1">
                <Button size="xs" variant="ghost" disabled={busy} onClick={() => onEdit(entry)}>
                  {translate('ledger.list.edit', 'Edit {{id}}', { id: entry.id })}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    onMutate({
                      operation: 'approve',
                      target,
                      selections: [{ id: entry.id, revision: entry.revision }]
                    })
                  }
                >
                  {translate('ledger.list.review', 'Review {{id}}', { id: entry.id })}
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  className="text-destructive"
                  disabled={busy}
                  onClick={() =>
                    onConfirm(
                      translate(
                        'ledger.list.deleteConfirm',
                        'Permanently delete {{id}} and its history?',
                        { id: entry.id }
                      ),
                      {
                        operation: 'delete-entries',
                        target,
                        selections: [{ id: entry.id, revision: entry.revision }],
                        confirmed: true
                      }
                    )
                  }
                >
                  {translate('ledger.list.delete', 'Delete {{id}}', { id: entry.id })}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
