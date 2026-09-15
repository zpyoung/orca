import { Loader2, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ApprovalScope, EscalationEntry } from '../../../shared/fork-heimdall/ledger-types'

export type HeimdallEscalationsProps = {
  entries: readonly EscalationEntry[]
  readOnly: boolean
  busyKey: string | null
  onApprove: (key: string, scope: ApprovalScope) => void
}

export function HeimdallEscalations({
  entries,
  readOnly,
  busyKey,
  onApprove
}: HeimdallEscalationsProps): React.JSX.Element | null {
  if (entries.length === 0) {
    return null
  }
  return (
    <section aria-labelledby="heimdall-escalations-title">
      <h3
        id="heimdall-escalations-title"
        className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground"
      >
        {translate('fork.heimdall.escalations.title', 'Open escalations')}
      </h3>
      <ul className="space-y-2">
        {entries.map((escalation) => {
          const approvalScope = escalation.approvalScope
          const approvalKey = `approve:${escalation.escalationId}`
          return (
            <li
              key={escalation.escalationId}
              className="rounded-md border border-status-warning-border bg-status-warning-background p-3 text-xs text-status-warning-foreground"
            >
              <div className="flex flex-wrap items-center gap-2 font-medium">
                <span>{escalation.escalationKind}</span>
                {escalation.foldCount > 1 ? (
                  <Badge variant="outline">×{escalation.foldCount}</Badge>
                ) : null}
              </div>
              {escalation.reason ? <p className="mt-1">{escalation.reason}</p> : null}
              {approvalScope ? (
                <Button
                  type="button"
                  size="xs"
                  className="mt-2"
                  disabled={readOnly || busyKey !== null}
                  onClick={() => onApprove(approvalKey, approvalScope)}
                >
                  {busyKey === approvalKey ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                  {translate('fork.heimdall.controls.approve', 'Approve')}
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
