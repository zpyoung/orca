import { describe, expect, it } from 'vitest'
import { buildWatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-test-fixtures'
import type { WatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-types'
import type { WatcherStatus } from '../../../shared/fork-heimdall/watcher-types'
import { sortHeimdallFleetRows } from './fleet-selectors'
import { watcherStatusLabel, watcherStatusTone } from './watcher-status-copy'

function rowWithStatus(watcherId: string, status: Partial<WatcherStatus>): WatcherFleetEntry {
  const row = buildWatcherFleetEntry(1, 1, watcherId)
  return { ...row, entry: { ...row.entry, status: { ...row.entry.status, ...status } } }
}

describe('watcher status copy for a failing tick', () => {
  const failing = rowWithStatus('failing', {
    state: 'held',
    phase: 'tick-error',
    reason: 'Question msg_1 was not found in Run run_1'
  })

  it('labels a reachable owner whose ticks fail as an error, not a lost host', () => {
    expect(watcherStatusLabel(failing.entry.status)).toBe('Error · retrying')
    expect(watcherStatusTone(failing)).toBe('warning')
  })

  it('keeps an ordinary held watcher neutral', () => {
    const held = rowWithStatus('held', { state: 'held', phase: 'paused', reason: 'paused' })
    expect(watcherStatusLabel(held.entry.status)).toBe('Held')
    expect(watcherStatusTone(held)).toBe('neutral')
  })

  it('ranks a failing tick with lost contact, ahead of held and watching rows', () => {
    const held = rowWithStatus('held', { state: 'held', phase: 'paused', reason: 'paused' })
    const watching = rowWithStatus('watching', { state: 'watching' })
    const unreachable = rowWithStatus('unreachable', { state: 'unreachable', phase: 'error' })
    const sorted = sortHeimdallFleetRows([watching, held, failing, unreachable])
    expect(sorted.map((row) => row.target.watcherId)).toEqual([
      'failing',
      'unreachable',
      'held',
      'watching'
    ])
  })
})
