import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { formatAsOf } from './session-info-format'

export function SessionInfoRow({
  label,
  value,
  mono = false,
  title
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
  title?: string
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] items-start gap-2 py-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'min-w-0 break-words text-right text-xs text-foreground',
          mono && 'font-mono'
        )}
        title={title}
      >
        {value}
      </dd>
    </div>
  )
}

export function SessionInfoWaiting({ label }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground" role="status">
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
      <span>{label ?? translate('fork.sessionInfo.waiting', 'Waiting for session data…')}</span>
    </div>
  )
}

export function SessionInfoAsOf({
  updatedAt,
  stale = false
}: {
  updatedAt: number | undefined
  stale?: boolean
}): React.JSX.Element | null {
  if (!updatedAt) {
    return null
  }
  const formatted = formatAsOf(updatedAt)
  const label = stale
    ? translate('fork.sessionInfo.staleAsOf', 'Stale · as of {{time}}', { time: formatted })
    : translate('fork.sessionInfo.asOf', 'As of {{time}}', { time: formatted })
  return (
    <p className={cn('pt-1 text-xs text-muted-foreground', stale && 'text-foreground')}>{label}</p>
  )
}
