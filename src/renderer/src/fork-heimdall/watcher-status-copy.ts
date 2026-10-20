import { translate } from '@/i18n/i18n'
import type { WatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-types'
import type {
  WatcherFleetEntryReader,
  WatcherKindIdReader
} from '../../../shared/fork-heimdall/remote-reader-schemas'
import { isWatcherTickErrorStatus } from '../../../shared/fork-heimdall/watcher-tick-error'
import type { WatcherStatus } from '../../../shared/fork-heimdall/watcher-types'
import { isHeimdallAttentionRow } from './fleet-selectors'
import type { HeimdallPillTone } from './heimdall-tone-pill'

export function watcherKindLabel(kind: WatcherKindIdReader): string {
  switch (kind) {
    case 'objective':
      return translate('fork.heimdall.kind.objectiveV1', 'Objective v1')
    case 'hosted-review':
      return translate('fork.heimdall.kind.prSitterV1', 'PR sitter v1')
    case 'pipeline':
      return translate('fork.heimdall.kind.pipeline', 'Pipeline')
    case 'unknown':
      return translate('fork.heimdall.kind.unknown', 'Unknown watcher')
  }
}

export function watcherStatusLabel(status: Pick<WatcherStatus, 'state' | 'phase'>): string {
  if (isWatcherTickErrorStatus(status)) {
    return translate('fork.heimdall.status.tickError', 'Error · retrying')
  }
  const labels: Record<WatcherStatus['state'], string> = {
    watching: translate('fork.heimdall.status.watching', 'Watching'),
    held: translate('fork.heimdall.status.held', 'Held'),
    acting: translate('fork.heimdall.status.acting', 'Acting'),
    escalated: translate('fork.heimdall.status.escalated', 'Escalated'),
    parked: translate('fork.heimdall.status.parked', 'Parked'),
    terminal: translate('fork.heimdall.status.terminal', 'Complete'),
    disabled: translate('fork.heimdall.status.disabled', 'Stopped'),
    unreachable: translate('fork.heimdall.status.unreachable', 'Host unreachable')
  }
  return labels[status.state]
}

export function watcherHostLabel(row: WatcherFleetEntryReader): string {
  return row.target.connectionId
    ? translate('fork.heimdall.host.remote', 'Remote · {{host}}', {
        host: row.target.connectionId
      })
    : translate('fork.heimdall.host.local', 'This device')
}

function isKnownWatcherEntry(row: WatcherFleetEntryReader): row is WatcherFleetEntry {
  return row.entry.enrollment.kind !== 'unknown'
}

export function watcherStatusTone(row: WatcherFleetEntryReader): HeimdallPillTone {
  if (
    row.contact === 'unverifiable' ||
    row.entry.status.state === 'unreachable' ||
    isWatcherTickErrorStatus(row.entry.status)
  ) {
    return 'warning'
  }
  if (isKnownWatcherEntry(row) && isHeimdallAttentionRow(row)) {
    return 'warning'
  }
  if (row.entry.status.state === 'watching' || row.entry.status.state === 'acting') {
    return 'success'
  }
  return 'neutral'
}
