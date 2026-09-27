import { getIntlLocale } from '@/i18n/i18n'

const timestampFormatters = new Map<string, Intl.DateTimeFormat>()

function timestampFormatter(timeStyle: 'short' | 'medium'): Intl.DateTimeFormat {
  const locale = getIntlLocale()
  const key = `${locale}:${timeStyle}`
  let formatter = timestampFormatters.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle })
    timestampFormatters.set(key, formatter)
  }
  return formatter
}

const countFormatters = new Map<string, Intl.NumberFormat>()

export function formatCount(value: number): string {
  const locale = getIntlLocale()
  let formatter = countFormatters.get(locale)
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { notation: 'compact' })
    countFormatters.set(locale, formatter)
  }
  return formatter.format(Math.max(0, value))
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
