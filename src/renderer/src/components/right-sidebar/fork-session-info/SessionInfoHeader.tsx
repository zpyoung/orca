import type { SessionInfo } from '../../../../../shared/fork-session-info/session-info-types'
import { translate } from '@/i18n/i18n'
import { contextFillClassName, formatAsOf, formatPercentage } from './session-info-format'

export function SessionInfoHeader({ info }: { info: SessionInfo }): React.JSX.Element {
  const context = info.context
  const percentage = context?.status === 'ready' ? context.usedPercentage : undefined
  const model = info.identity?.model
  const agent = info.identity?.agent
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/95 px-3 py-3 backdrop-blur-sm">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">
            {translate('fork.sessionInfo.title', 'Session Info')}
          </h2>
          <p className="truncate text-xs text-muted-foreground" title={model ?? agent}>
            {model ?? agent ?? translate('fork.sessionInfo.agent', 'Agent session')}
          </p>
        </div>
        {context ? (
          <div className="shrink-0 text-right">
            <p className="text-lg font-semibold tabular-nums text-foreground">
              {percentage === undefined ? '—' : formatPercentage(percentage)}
            </p>
            <p className="text-xs text-muted-foreground">
              {percentage === undefined
                ? translate('fork.sessionInfo.contextWaiting', 'Waiting for context')
                : translate('fork.sessionInfo.contextUsed', 'context used')}
            </p>
          </div>
        ) : null}
      </div>
      {context ? (
        <div
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
          role={percentage === undefined ? undefined : 'progressbar'}
          aria-label={translate('fork.sessionInfo.contextFill', 'Context fill')}
          aria-valuemin={percentage === undefined ? undefined : 0}
          aria-valuemax={percentage === undefined ? undefined : 100}
          aria-valuenow={percentage}
        >
          {percentage !== undefined ? (
            <div
              className={`h-full rounded-full transition-[width] motion-reduce:transition-none ${contextFillClassName(percentage)}`}
              style={{ width: `${Math.min(100, Math.max(0, percentage))}%` }}
            />
          ) : null}
        </div>
      ) : null}
      {context?.updatedAt ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {translate('fork.sessionInfo.asOf', 'As of {{time}}', {
            time: formatAsOf(context.updatedAt)
          })}
        </p>
      ) : null}
    </header>
  )
}
