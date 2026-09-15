import { AlertTriangle, CircleCheck, CircleX, Clock3, ShieldQuestion } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ReviewPanelRun } from './adversarial-review-model'
import { translate } from '@/i18n/i18n'

const VERDICT_COPY = {
  PASS: 'Pass',
  NEEDS_FIXES: 'Needs fixes',
  CRITICAL_ISSUES: 'Critical issues',
  NOT_REVIEWABLE: 'Not reviewable'
} as const

const VERDICT_ICON = {
  PASS: CircleCheck,
  NEEDS_FIXES: AlertTriangle,
  CRITICAL_ISSUES: CircleX,
  NOT_REVIEWABLE: ShieldQuestion
} as const

export function ReviewRunHeader({ run }: { run: ReviewPanelRun }): React.JSX.Element {
  const Icon = run.verdict ? VERDICT_ICON[run.verdict] : Clock3
  const verdictCopy = run.verdict ? VERDICT_COPY[run.verdict] : 'Review in progress'
  const destructive = run.verdict === 'CRITICAL_ISSUES'

  return (
    <div className="space-y-3 border-b border-border px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {run.independence === 'reduced' ? (
          <Badge variant="outline">
            {translate('adversarialReview.header.reduced', 'Independence: reduced')}
          </Badge>
        ) : null}
        <div
          className={cn(
            'flex min-w-0 items-center gap-2 text-sm font-medium',
            destructive && 'text-destructive'
          )}
        >
          <Icon className="size-4 shrink-0" />
          <span>{verdictCopy}</span>
        </div>
        <Badge variant="secondary">{run.state}</Badge>
      </div>
      <div className="space-y-1 text-xs text-muted-foreground">
        <p className="truncate font-mono" title={run.target}>
          {run.target}
        </p>
        <p>
          {run.profile} · {run.depth} ·{' '}
          <time dateTime={run.updatedAt}>{new Date(run.updatedAt).toLocaleString()}</time>
        </p>
      </div>
      {run.stale ? (
        <div className="rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs">
          <div className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="size-3.5" />
            {translate('adversarialReview.header.stale', 'Verdict is stale')}
          </div>
          <p className="mt-1 truncate text-muted-foreground" title={run.stale.target}>
            {run.stale.target} {translate('adversarialReview.header.changed', 'changed ·')}{' '}
            <time dateTime={run.stale.detectedAt}>
              {new Date(run.stale.detectedAt).toLocaleString()}
            </time>
          </p>
        </div>
      ) : null}
    </div>
  )
}
