import { describe, expect, it } from 'vitest'
import { buildWatcherFleetEntry } from '../../shared/fork-heimdall/fleet-test-fixtures'
import type { WatcherFleetEntry } from '../../shared/fork-heimdall/fleet-types'
import type { WatcherStatus } from '../../shared/fork-heimdall/watcher-types'
import { sortFleetEntries } from './fleet-projection'
import { sortLocalFleetByAttention } from './local-fleet-projection'

function rowWithStatus(watcherId: string, status: Partial<WatcherStatus>): WatcherFleetEntry {
  const row = buildWatcherFleetEntry(1, 1, watcherId)
  return { ...row, entry: { ...row.entry, status: { ...row.entry.status, ...status } } }
}

describe('fleet attention for a failing tick', () => {
  const rows = (): WatcherFleetEntry[] => [
    rowWithStatus('watching', { state: 'watching' }),
    rowWithStatus('held', { state: 'held', phase: 'paused', reason: 'paused' }),
    rowWithStatus('failing', { state: 'held', phase: 'tick-error', reason: 'boom' })
  ]

  it('ranks it first in the merged fleet', () => {
    expect(sortFleetEntries(rows()).map((row) => row.target.watcherId)).toEqual([
      'failing',
      'held',
      'watching'
    ])
  })

  it('ranks it ahead of held watchers in the local read model', () => {
    expect(sortLocalFleetByAttention(rows()).map((row) => row.target.watcherId)).toEqual([
      'failing',
      'held',
      'watching'
    ])
  })
})
