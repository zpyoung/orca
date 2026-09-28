import { describe, expect, it } from 'vitest'
import {
  WatcherFleetEntrySchema,
  type WatcherFleetEntry
} from '../../../shared/fork-heimdall/fleet-types'
import { buildWatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-test-fixtures'
import type { WatcherStatusState } from '../../../shared/fork-heimdall/watcher-types'
import {
  countHeimdallFleetBuckets,
  HEIMDALL_FLEET_BUCKET_ORDER,
  heimdallFleetBucket,
  type HeimdallFleetBucket
} from './fleet-selectors'

function fleetRow(overrides: {
  state: WatcherStatusState
  reason?: string | null
  parkReason?: WatcherFleetEntry['entry']['status']['parkReason']
  enabled?: boolean
  paused?: boolean
  contact?: WatcherFleetEntry['contact']
}): WatcherFleetEntry {
  const base = buildWatcherFleetEntry(1)
  return WatcherFleetEntrySchema.parse({
    ...base,
    paused: overrides.paused ?? base.paused,
    contact: overrides.contact ?? base.contact,
    entry: {
      ...base.entry,
      status: {
        ...base.entry.status,
        state: overrides.state,
        reason: overrides.reason ?? null,
        parkReason: overrides.parkReason ?? null,
        enabled: overrides.enabled ?? base.entry.status.enabled
      }
    }
  })
}

const stateBuckets: { state: WatcherStatusState; bucket: HeimdallFleetBucket }[] = [
  { state: 'watching', bucket: 'active' },
  { state: 'held', bucket: 'active' },
  { state: 'acting', bucket: 'active' },
  { state: 'escalated', bucket: 'attention' },
  { state: 'parked', bucket: 'attention' },
  { state: 'terminal', bucket: 'inactive' },
  { state: 'disabled', bucket: 'inactive' },
  { state: 'unreachable', bucket: 'lostContact' }
]

describe('Heimdall fleet buckets', () => {
  it('orders the four buckets by urgency', () => {
    expect(HEIMDALL_FLEET_BUCKET_ORDER).toEqual(['attention', 'lostContact', 'active', 'inactive'])
  })

  it.each(stateBuckets)('classifies $state as $bucket', ({ state, bucket }) => {
    expect(heimdallFleetBucket(fleetRow({ state }))).toBe(bucket)
  })

  it('classifies a held row awaiting approval or a worker question as attention', () => {
    expect(heimdallFleetBucket(fleetRow({ state: 'held', reason: 'awaiting-approval' }))).toBe(
      'attention'
    )
    expect(
      heimdallFleetBucket(
        fleetRow({
          state: 'held',
          parkReason: { kind: 'worker-question', messageId: 'question-1' }
        })
      )
    ).toBe('attention')
    expect(heimdallFleetBucket(fleetRow({ state: 'held' }))).toBe('active')
  })

  it('classifies paused and switched-off watchers as inactive after urgent signals', () => {
    expect(heimdallFleetBucket(fleetRow({ state: 'held', paused: true, reason: 'paused' }))).toBe(
      'inactive'
    )
    expect(heimdallFleetBucket(fleetRow({ state: 'held', reason: 'paused' }))).toBe('inactive')
    expect(heimdallFleetBucket(fleetRow({ state: 'watching', enabled: false }))).toBe('inactive')
    expect(heimdallFleetBucket(fleetRow({ state: 'watching', paused: true }))).toBe('inactive')
    expect(
      heimdallFleetBucket(fleetRow({ state: 'held', paused: true, contact: 'unverifiable' }))
    ).toBe('lostContact')
    expect(heimdallFleetBucket(fleetRow({ state: 'escalated', paused: true }))).toBe('attention')
  })

  it('prioritizes attention over lost contact and lost contact over state', () => {
    expect(heimdallFleetBucket(fleetRow({ state: 'escalated', contact: 'unverifiable' }))).toBe(
      'attention'
    )
    expect(heimdallFleetBucket(fleetRow({ state: 'watching', contact: 'unverifiable' }))).toBe(
      'lostContact'
    )
    expect(heimdallFleetBucket(fleetRow({ state: 'terminal', contact: 'unverifiable' }))).toBe(
      'lostContact'
    )
    expect(heimdallFleetBucket(fleetRow({ state: 'unreachable', contact: 'live' }))).toBe(
      'lostContact'
    )
  })

  it('returns every bucket at zero for an empty fleet', () => {
    expect(countHeimdallFleetBuckets([])).toEqual({
      attention: 0,
      lostContact: 0,
      active: 0,
      inactive: 0
    })
  })

  it('counts every row exactly once in a mixed fleet', () => {
    const rows = [
      ...stateBuckets.map(({ state }) => fleetRow({ state })),
      fleetRow({ state: 'held', reason: 'awaiting-approval' }),
      fleetRow({ state: 'watching', contact: 'unverifiable' }),
      fleetRow({ state: 'held', paused: true, reason: 'paused' })
    ]
    const counts = countHeimdallFleetBuckets(rows)
    expect(counts).toEqual({ attention: 3, lostContact: 2, active: 3, inactive: 3 })
    expect(Object.values(counts).reduce((total, count) => total + count, 0)).toBe(rows.length)
  })
})
