import { Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { HeimdallFleetAction } from './fleet-action-history'
import { formatHeimdallAge } from './fleet-format'

export function HeimdallFleetActivity({
  actions,
  loading,
  partialFailures,
  asOfMs
}: {
  actions: readonly HeimdallFleetAction[]
  loading: boolean
  partialFailures: number
  asOfMs: number | null
}): React.JSX.Element {
  return (
    <section className="mt-6" aria-labelledby="heimdall-fleet-actions-title">
      <div className="mb-2 flex items-center gap-2">
        <h2
          id="heimdall-fleet-actions-title"
          className="text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground"
        >
          {translate('fork.heimdall.activity.title', 'Fleet action history')}
        </h2>
        {loading ? (
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
        ) : null}
        {asOfMs !== null ? (
          <span className="ml-auto text-[11px] text-muted-foreground">
            {translate('fork.heimdall.activity.asOf', 'As of {{age}}', {
              age: formatHeimdallAge(asOfMs)
            })}
          </span>
        ) : null}
      </div>
      {partialFailures > 0 ? (
        <p
          className="mb-2 rounded-md border border-status-warning-border bg-status-warning-background px-3 py-2 text-xs text-status-warning-foreground"
          role="status"
        >
          {translate(
            'fork.heimdall.activity.partial',
            '{{count}} watcher histories could not be refreshed; visible records are retained.',
            { count: partialFailures }
          )}
        </p>
      ) : null}
      {actions.length === 0 && !loading ? (
        <p className="rounded-md border border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
          {translate('fork.heimdall.activity.empty', 'No autonomous actions recorded yet.')}
        </p>
      ) : (
        <ol className="divide-y divide-border rounded-md border border-border bg-muted/10">
          {actions.slice(0, 50).map(({ watcherKey, watcherName, attempt }) => (
            <li
              key={`${watcherKey}:${attempt.attemptId}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs"
            >
              <span className="min-w-0 flex-1 truncate font-medium" title={watcherName}>
                {watcherName}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {attempt.action.kind}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {attempt.action.capability} · {attempt.action.visibility}
              </span>
              <Badge variant="outline">
                <span className="text-[10px]">{attempt.effect ?? attempt.state}</span>
              </Badge>
              <time
                className="text-[11px] text-muted-foreground"
                dateTime={new Date(attempt.atMs).toISOString()}
              >
                {formatHeimdallAge(attempt.atMs)}
              </time>
              {attempt.reason ? (
                <p className="basis-full text-[11px] text-muted-foreground">{attempt.reason}</p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}
