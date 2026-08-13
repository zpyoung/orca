import { describe, expect, it } from 'vitest'
import { formatPipelineElapsedTime, pipelineNodeElapsedMs } from './pipeline-canvas-elapsed-time'

describe('pipelineNodeElapsedMs', () => {
  it('returns null when startedAt is missing', () => {
    expect(
      pipelineNodeElapsedMs({
        startedAt: undefined,
        publishedAt: '2026-01-01T00:01:00.000Z',
        nowMs: 0,
        receivedAtMs: 0
      })
    ).toBeNull()
  })

  it('returns null when publishedAt is missing', () => {
    expect(
      pipelineNodeElapsedMs({
        startedAt: '2026-01-01T00:00:00.000Z',
        publishedAt: undefined,
        nowMs: 0,
        receivedAtMs: 0
      })
    ).toBeNull()
  })

  it('returns null for an unparseable timestamp', () => {
    expect(
      pipelineNodeElapsedMs({
        startedAt: 'not-a-date',
        publishedAt: '2026-01-01T00:01:00.000Z',
        nowMs: 0,
        receivedAtMs: 0
      })
    ).toBeNull()
  })

  it('computes the host-clock elapsed duration when no local time has passed', () => {
    const result = pipelineNodeElapsedMs({
      startedAt: '2026-01-01T00:00:00.000Z',
      publishedAt: '2026-01-01T00:01:05.000Z',
      nowMs: 1000,
      receivedAtMs: 1000
    })
    expect(result).toBe(65_000)
  })

  it('adds the local-clock delta since the snapshot was received on top of the host-derived base', () => {
    const result = pipelineNodeElapsedMs({
      startedAt: '2026-01-01T00:00:00.000Z',
      publishedAt: '2026-01-01T00:01:00.000Z',
      nowMs: 5_000,
      receivedAtMs: 1_000
    })
    // base = 60_000 (host clocks only) + 4_000 (local tick since receipt) = 64_000.
    // Proves the function never substitutes nowMs for publishedAt directly (client-clock
    // vs host-clock skew must never leak in) — it only ever adds a same-clock delta.
    expect(result).toBe(64_000)
  })

  it('clamps a negative host-clock span to zero instead of going negative', () => {
    const result = pipelineNodeElapsedMs({
      startedAt: '2026-01-01T00:01:00.000Z',
      publishedAt: '2026-01-01T00:00:00.000Z',
      nowMs: 0,
      receivedAtMs: 0
    })
    expect(result).toBe(0)
  })

  it('clamps a negative local tick to zero instead of going negative', () => {
    const result = pipelineNodeElapsedMs({
      startedAt: '2026-01-01T00:00:00.000Z',
      publishedAt: '2026-01-01T00:01:00.000Z',
      nowMs: 0,
      receivedAtMs: 5_000
    })
    expect(result).toBe(60_000)
  })
})

describe('formatPipelineElapsedTime', () => {
  it('renders sub-minute durations as seconds only', () => {
    expect(formatPipelineElapsedTime(45_000)).toBe('45s')
  })

  it('renders exactly zero as 0s', () => {
    expect(formatPipelineElapsedTime(0)).toBe('0s')
  })

  it('renders minute-and-seconds durations with a zero-padded seconds part', () => {
    expect(formatPipelineElapsedTime(65_000)).toBe('1m 05s')
  })

  it('renders exact minutes with 00 seconds', () => {
    expect(formatPipelineElapsedTime(120_000)).toBe('2m 00s')
  })
})
