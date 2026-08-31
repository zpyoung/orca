import { getIntlLocale } from '@/i18n/i18n'

function timestampFormatter(timeStyle: 'short' | 'medium'): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(getIntlLocale(), { dateStyle: 'medium', timeStyle })
}

export function formatCount(value: number): string {
  return new Intl.NumberFormat(getIntlLocale(), { notation: 'compact' }).format(Math.max(0, value))
}

export function formatPercentage(value: number): string {
  const bounded = Math.min(100, Math.max(0, value))
  return `${Math.round(bounded)}%`
}

export function formatTimestamp(value: number): string {
  return timestampFormatter('short').format(new Date(value))
}

export function formatAsOf(value: number): string {
  return timestampFormatter('medium').format(new Date(value))
}

export function contextFillClassName(value: number): string {
  if (value < 60) {
    return 'bg-muted-foreground/40'
  }
  if (value < 80) {
    return 'bg-foreground/70'
  }
  return 'bg-destructive'
}
