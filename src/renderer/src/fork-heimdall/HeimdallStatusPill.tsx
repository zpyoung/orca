import { WifiOff } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { WatcherFleetEntryReader } from '../../../shared/fork-heimdall/remote-reader-schemas'
import { formatHeimdallAge } from './fleet-format'
import { HeimdallTonePill } from './heimdall-tone-pill'
import { watcherStatusLabel, watcherStatusTone } from './watcher-status-copy'

export function HeimdallStatusPill({ row }: { row: WatcherFleetEntryReader }): React.JSX.Element {
  const lostContact = row.contact === 'unverifiable' || row.entry.status.state === 'unreachable'
  const label = lostContact
    ? translate('fork.heimdall.status.lostContact', 'Host unreachable · last confirmed {{age}}', {
        age: formatHeimdallAge(row.observedAtMs)
      })
    : watcherStatusLabel(row.entry.status)
  return (
    <HeimdallTonePill tone={watcherStatusTone(row)} title={label}>
      {lostContact ? <WifiOff aria-hidden /> : null}
      {label}
    </HeimdallTonePill>
  )
}
