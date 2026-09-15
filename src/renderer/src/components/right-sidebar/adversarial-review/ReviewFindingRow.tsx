import { useMemo, useState } from 'react'
import { Bot, ExternalLink, MessageSquareX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Badge } from '@/components/ui/badge'
import type { Finding } from '../../../../../shared/review/finding-schema'
import type { ReviewFixAgentSession } from './adversarial-review-model'
import { translate } from '@/i18n/i18n'

const EMPTY_SESSIONS: ReviewFixAgentSession[] = []

type ReviewFindingRowProps = {
  finding: Finding
  sessions?: ReviewFixAgentSession[]
  onOpenEvidence?: (finding: Finding) => void
  onDismiss?: (finding: Finding, reason: string) => void | Promise<void>
  onSendToAgent?: (
    finding: Finding,
    destination: { kind: 'new' } | { kind: 'existing'; sessionId: string }
  ) => void | Promise<void>
}

function evidenceLabel(finding: Finding): string {
  const first = finding.evidence[0]
  if ('ref' in first) {
    return first.ref
  }
  return first.command
}

export function ReviewFindingRow({
  finding,
  sessions = EMPTY_SESSIONS,
  onOpenEvidence,
  onDismiss,
  onSendToAgent
}: ReviewFindingRowProps): React.JSX.Element {
  const [dismissOpen, setDismissOpen] = useState(false)
  const [reason, setReason] = useState('')
  const canDismiss = reason.trim().length > 0
  const evidence = useMemo(() => evidenceLabel(finding), [finding])

  return (
    <article className="space-y-2 border-b border-border px-3 py-3 last:border-b-0">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-medium leading-5">{finding.claim}</p>
        <Badge variant={finding.severity === 'CRITICAL' ? 'destructive' : 'outline'}>
          {finding.effective_severity ?? finding.severity}
        </Badge>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{finding.remediation}</p>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={!onOpenEvidence}
          onClick={() => onOpenEvidence?.(finding)}
          title={evidence}
        >
          <ExternalLink className="size-3.5" />
          {translate('adversarialReview.finding.evidence', 'Evidence')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={!onDismiss}
          onClick={() => setDismissOpen(true)}
        >
          <MessageSquareX className="size-3.5" />
          {translate('adversarialReview.finding.dismiss', 'Dismiss')}
        </Button>
        <Popover>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="xs" disabled={!onSendToAgent}>
              <Bot className="size-3.5" />
              {translate('adversarialReview.finding.sendToAgent', 'Send to agent')}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => void onSendToAgent?.(finding, { kind: 'new' })}
            >
              {translate('adversarialReview.finding.newAgent', 'New agent tab…')}
            </Button>
            {sessions.map((session) => (
              <Button
                key={session.id}
                type="button"
                variant="ghost"
                size="sm"
                className="w-full justify-start truncate"
                onClick={() =>
                  void onSendToAgent?.(finding, { kind: 'existing', sessionId: session.id })
                }
              >
                {session.label}
              </Button>
            ))}
          </PopoverContent>
        </Popover>
      </div>

      <Dialog open={dismissOpen} onOpenChange={setDismissOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {translate('adversarialReview.finding.dismissTitle', 'Dismiss finding')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'adversarialReview.finding.dismissDescription',
                'The reason stays in this campaign and is never sent to later review stages.'
              )}
            </DialogDescription>
          </DialogHeader>
          <textarea
            rows={4}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={translate(
              'adversarialReview.finding.dismissPlaceholder',
              'Why is this finding not applicable?'
            )}
            className="w-full resize-y rounded-md border border-border bg-input px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setDismissOpen(false)}>
              {translate('adversarialReview.finding.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              disabled={!canDismiss}
              onClick={() => {
                if (!canDismiss) {
                  return
                }
                void Promise.resolve(onDismiss?.(finding, reason.trim())).then(() => {
                  setReason('')
                  setDismissOpen(false)
                })
              }}
            >
              {translate('adversarialReview.finding.dismissConfirm', 'Dismiss finding')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </article>
  )
}
