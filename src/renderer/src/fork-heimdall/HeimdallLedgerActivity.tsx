import { translate } from '@/i18n/i18n'
import type { LedgerEntry, WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import { formatHeimdallAge } from './fleet-format'

function entrySummary(entry: LedgerEntry): string {
  switch (entry.kind) {
    case 'attempt':
      return `${entry.action.kind} · ${entry.effect ?? entry.state}`
    case 'attempt-resolved':
      return `${translate('fork.heimdall.ledger.attemptResolved', 'Attempt resolved')} · ${entry.effect}`
    case 'attempt-abandoned':
      return `${translate('fork.heimdall.ledger.attemptAbandoned', 'Attempt abandoned')} · ${entry.reason}`
    case 'approval':
      return `${entry.scope.actionKind} · ${entry.decision}`
    case 'escalation':
      return `${entry.escalationKind} · ${entry.status}${entry.foldCount > 1 ? ` ×${entry.foldCount}` : ''}`
    case 'evidence':
      return `${translate('fork.heimdall.ledger.evidence', 'Evidence')} · ${entry.evidenceKind}`
    case 'interval-open':
      return `${translate('fork.heimdall.ledger.activeTimeStarted', 'Active time started')} · ${entry.cause}`
    case 'interval-checkpoint':
      return translate('fork.heimdall.ledger.activeTimeChecked', 'Active time checkpoint')
    case 'interval-close':
      return `${translate('fork.heimdall.ledger.activeTimeStopped', 'Active time stopped')} · ${entry.closeReason}`
    case 'turn':
      return `${translate('fork.heimdall.ledger.workerTurn', 'Worker turn')} · ${entry.dispatchKind}`
    case 'client-observation':
      return `${entry.what}${entry.detail ? ` · ${entry.detail}` : ''}`
    case 'terminal':
      return `${translate('fork.heimdall.ledger.finished', 'Finished')} · ${entry.state} · ${entry.reason}`
  }
}

export function HeimdallLedgerActivity({ ledger }: { ledger: WatcherLedger }): React.JSX.Element {
  const entries = [...ledger.entries].sort((a, b) => b.atMs - a.atMs).slice(0, 30)
  if (entries.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {translate('fork.heimdall.ledger.empty', 'No activity recorded yet.')}
      </p>
    )
  }
  return (
    <ol className="divide-y divide-border rounded-md border border-border bg-muted/10">
      {entries.map((entry) => (
        <li
          key={entry.eventId}
          className="flex items-start justify-between gap-3 px-3 py-2 text-xs"
        >
          <span className="min-w-0 break-words">{entrySummary(entry)}</span>
          <time
            className="shrink-0 text-[11px] text-muted-foreground"
            dateTime={new Date(entry.atMs).toISOString()}
          >
            {formatHeimdallAge(entry.atMs)}
          </time>
        </li>
      ))}
    </ol>
  )
}
