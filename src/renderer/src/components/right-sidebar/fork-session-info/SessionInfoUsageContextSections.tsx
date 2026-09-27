import type {
  SessionInfoContext,
  SessionInfoUsage
} from '../../../../../shared/fork-session-info/session-info-types'
import type { RateLimitWindow } from '../../../../../shared/rate-limit-types'
import { translate } from '@/i18n/i18n'
import { formatCount, formatPercentage, formatTimestamp } from './session-info-format'
import { SessionInfoAsOf, SessionInfoRow, SessionInfoWaiting } from './SessionInfoRows'

export function SessionInfoUsageSection({ usage }: { usage: SessionInfoUsage }): React.JSX.Element {
  if (usage.status === 'waiting') {
    return (
      <SessionInfoWaiting
        label={translate('fork.sessionInfo.usageWaiting', 'Waiting for the first completed turn…')}
      />
    )
  }
  const stale = usage.freshness === 'stale' || usage.freshness === 'refreshing'
  return (
    <div>
      <dl>
        <SessionInfoRow
          label={translate('fork.sessionInfo.totalTokens', 'Total tokens')}
          value={formatCount(usage.totalTokens)}
        />
        <SessionInfoRow
          label={translate('fork.sessionInfo.turns', 'Turns')}
          value={formatCount(usage.turnCount)}
        />
        <SessionInfoRow
          label={translate('fork.sessionInfo.inputTokens', 'Input')}
          value={formatCount(usage.inputTokens)}
        />
        <SessionInfoRow
          label={translate('fork.sessionInfo.outputTokens', 'Output')}
          value={formatCount(usage.outputTokens)}
        />
        <SessionInfoRow
          label={translate('fork.sessionInfo.cacheReadTokens', 'Cache read')}
          value={formatCount(usage.cacheReadTokens)}
        />
        <SessionInfoRow
          label={translate('fork.sessionInfo.cacheWriteTokens', 'Cache write')}
          value={formatCount(usage.cacheWriteTokens)}
        />
      </dl>
      {usage.error ? <p className="pt-1 text-xs text-destructive">{usage.error}</p> : null}
      <SessionInfoAsOf updatedAt={usage.updatedAt} stale={stale} />
    </div>
  )
}

function RateLimitRow({
  label,
  window
}: {
  label: string
  window: RateLimitWindow
}): React.JSX.Element {
  const reset = window.resetsAt
    ? translate('fork.sessionInfo.resetsAt', '{{used}} · resets {{time}}', {
        used: formatPercentage(window.usedPercent),
        time: formatTimestamp(window.resetsAt)
      })
    : formatPercentage(window.usedPercent)
  return <SessionInfoRow label={label} value={reset} />
}

export function SessionInfoContextSection({
  context
}: {
  context: SessionInfoContext
}): React.JSX.Element {
  const hasPlanWindows = Boolean(context.fiveHour || context.sevenDay)
  if (context.status === 'waiting' && !hasPlanWindows) {
    return (
      <SessionInfoWaiting
        label={translate(
          'fork.sessionInfo.contextWaitingLong',
          'Waiting for the first statusline update…'
        )}
      />
    )
  }
  return (
    <div>
      {context.status === 'waiting' ? (
        <SessionInfoWaiting
          label={translate('fork.sessionInfo.contextWaitingShort', 'Waiting for context data…')}
        />
      ) : null}
      <dl>
        {context.usedPercentage !== undefined ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.contextUsedLabel', 'Used')}
            value={formatPercentage(context.usedPercentage)}
          />
        ) : null}
        {context.remainingPercentage !== undefined ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.contextRemaining', 'Remaining')}
            value={formatPercentage(context.remainingPercentage)}
          />
        ) : null}
        {context.windowSize !== undefined ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.contextWindow', 'Window')}
            value={formatCount(context.windowSize)}
          />
        ) : null}
        {context.fiveHour ? (
          <RateLimitRow
            label={translate('fork.sessionInfo.fiveHour', '5 hour plan')}
            window={context.fiveHour}
          />
        ) : null}
        {context.sevenDay ? (
          <RateLimitRow
            label={translate('fork.sessionInfo.sevenDay', '7 day plan')}
            window={context.sevenDay}
          />
        ) : null}
      </dl>
      <SessionInfoAsOf updatedAt={context.updatedAt} />
    </div>
  )
}
