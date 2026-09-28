import type { HeimdallPillTone } from './heimdall-tone-pill'
import { translate } from '@/i18n/i18n'
import type { WatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-types'
import type { WatcherKindId, WatcherStatusState } from '../../../shared/fork-heimdall/watcher-types'
import { isHeimdallAttentionRow } from './fleet-selectors'

export function watcherKindLabel(kind: WatcherKindId): string {
  return kind === 'hosted-review'
    ? translate('fork.hostedReviewSitter.title', 'PR Sitter')
    : translate('fork.heimdall.kind.objective', 'Objective watcher')
}

export function watcherStatusLabel(state: WatcherStatusState): string {
  const labels: Record<WatcherStatusState, string> = {
    watching: translate('fork.heimdall.status.watching', 'Watching'),
    held: translate('fork.heimdall.status.held', 'Held'),
    acting: translate('fork.heimdall.status.acting', 'Acting'),
    escalated: translate('fork.heimdall.status.escalated', 'Escalated'),
    parked: translate('fork.heimdall.status.parked', 'Parked'),
    terminal: translate('fork.heimdall.status.terminal', 'Complete'),
    disabled: translate('fork.heimdall.status.disabled', 'Stopped'),
    unreachable: translate('fork.heimdall.status.unreachable', 'Host unreachable')
  }
  return labels[state]
}

export function watcherHostLabel(row: WatcherFleetEntry): string {
  return row.target.connectionId
    ? translate('fork.heimdall.host.remote', 'Remote · {{host}}', {
        host: row.target.connectionId
      })
    : translate('fork.heimdall.host.local', 'This device')
}

export function watcherStatusTone(row: WatcherFleetEntry): HeimdallPillTone {
  if (row.contact === 'unverifiable' || row.entry.status.state === 'unreachable') {
    return 'warning'
  }
  if (isHeimdallAttentionRow(row)) {
    return 'warning'
  }
  if (row.entry.status.state === 'watching' || row.entry.status.state === 'acting') {
    return 'success'
  }
  return 'neutral'
}
