import type React from 'react'

export type HeimdallPillTone = 'warning' | 'success' | 'neutral' | 'destructive'

type HeimdallTonePillProps = Omit<React.ComponentProps<'span'>, 'className'> & {
  tone: HeimdallPillTone
}

const PILL_BASE =
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap [&>svg]:pointer-events-none [&>svg]:size-3'

const PILL_TONE: Record<HeimdallPillTone, string> = {
  warning:
    'border-status-warning-border bg-status-warning-background text-status-warning-foreground',
  success: 'border-status-success-border bg-status-success-background text-status-success',
  neutral: 'border-border bg-muted text-muted-foreground',
  destructive: 'border-destructive/30 bg-destructive/10 text-destructive'
}

/**
 * Status pill in the documented status token families. Badge has no status-tone variant, and
 * restyling Badge's owned colors is barred, so the fork renders its own pill.
 */
export function HeimdallTonePill({ tone, ...props }: HeimdallTonePillProps): React.JSX.Element {
  return <span data-tone={tone} className={`${PILL_BASE} ${PILL_TONE[tone]}`} {...props} />
}
