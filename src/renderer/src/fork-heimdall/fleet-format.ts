import { translate } from '@/i18n/i18n'
import { formatShortTimeAgo } from '@/lib/short-time-ago'

export function formatHeimdallDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(totalMinutes / 1_440)
  const hours = Math.floor((totalMinutes % 1_440) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) {
    return `${days}d ${hours}h`
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return `${minutes}m`
}

export function formatHeimdallAge(atMs: number | null, now = Date.now()): string {
  if (atMs === null) {
    return translate('fork.heimdall.time.never', 'Never')
  }
  const age = formatShortTimeAgo(atMs, now)
  return age === 'now'
    ? translate('fork.heimdall.time.now', 'now')
    : translate('fork.heimdall.time.ago', '{{age}} ago', { age })
}

export function formatHeimdallTime(atMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(atMs)
}

export function formatHeimdallJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
