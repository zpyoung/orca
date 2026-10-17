import { describe, expect, it } from 'vitest'
import {
  createInputAttribution,
  LOOP_USER_IDLE_MS,
  LOOP_WRITE_ATTRIBUTION_SLACK_MS
} from './input-attribution'

function runtimeWithInput(initial: number | null = null) {
  const state = { lastInputAt: initial }
  return {
    state,
    runtime: { terminalRunFacts: { readLastInputAt: () => state.lastInputAt } }
  }
}

function clock(start: number) {
  const time = { now: start }
  return { time, now: () => time.now }
}

describe('createInputAttribution', () => {
  it('attributes input inside a recorded loop write window to the loop', () => {
    const { state, runtime } = runtimeWithInput()
    const { time, now } = clock(10_000)
    const attribution = createInputAttribution(runtime, { now })

    attribution.noteLoopWrite('pty-1', 10_000)
    state.lastInputAt = 10_200
    time.now = 10_400
    attribution.noteLoopWrite('pty-1', 10_400)

    expect(attribution.userInputSince('pty-1', 9_000)).toBe(false)
  })

  it('still attributes input within the slack after the write settled', () => {
    const { state, runtime } = runtimeWithInput()
    const { time, now } = clock(10_000)
    const attribution = createInputAttribution(runtime, { now })

    attribution.noteLoopWrite('pty-1', 10_000)
    attribution.noteLoopWrite('pty-1', 10_400)
    state.lastInputAt = 10_400 + LOOP_WRITE_ATTRIBUTION_SLACK_MS
    time.now = 13_000

    expect(attribution.userInputSince('pty-1', 9_000)).toBe(false)
  })

  it('treats input after the slack as the user', () => {
    const { state, runtime } = runtimeWithInput()
    const { time, now } = clock(10_000)
    const attribution = createInputAttribution(runtime, { now })

    attribution.noteLoopWrite('pty-1', 10_000)
    attribution.noteLoopWrite('pty-1', 10_400)
    state.lastInputAt = 10_400 + LOOP_WRITE_ATTRIBUTION_SLACK_MS + 1
    time.now = 13_000

    expect(attribution.userInputSince('pty-1', 9_000)).toBe(true)
  })

  it('does not count user input older than the since bound', () => {
    const { runtime } = runtimeWithInput(5_000)
    const attribution = createInputAttribution(runtime, { now: () => 20_000 })

    expect(attribution.userInputSince('pty-1', 6_000)).toBe(false)
    expect(attribution.userInputSince('pty-1', 5_000)).toBe(true)
  })

  it('keeps a user keystroke seen before a later loop write', () => {
    const { state, runtime } = runtimeWithInput()
    const { time, now } = clock(10_000)
    const attribution = createInputAttribution(runtime, { now })

    state.lastInputAt = 9_000
    time.now = 20_000
    attribution.noteLoopWrite('pty-1', 20_000)
    state.lastInputAt = 20_100
    attribution.noteLoopWrite('pty-1', 20_300)

    expect(attribution.userInputSince('pty-1', 8_000)).toBe(true)
    expect(attribution.userInputSince('pty-1', 9_500)).toBe(false)
  })

  it('reports idle only after LOOP_USER_IDLE_MS without user input', () => {
    const { runtime } = runtimeWithInput(1_000)
    const { time, now } = clock(1_000)
    const attribution = createInputAttribution(runtime, { now })

    time.now = 1_000 + LOOP_USER_IDLE_MS - 1
    expect(attribution.userIdleFor('pty-1', LOOP_USER_IDLE_MS)).toBe(false)
    time.now = 1_000 + LOOP_USER_IDLE_MS
    expect(attribution.userIdleFor('pty-1', LOOP_USER_IDLE_MS)).toBe(true)
  })

  it('reports idle when the loop wrote and the user never did', () => {
    const { state, runtime } = runtimeWithInput()
    const { time, now } = clock(10_000)
    const attribution = createInputAttribution(runtime, { now })

    attribution.noteLoopWrite('pty-1', 10_000)
    state.lastInputAt = 10_100
    attribution.noteLoopWrite('pty-1', 10_200)
    time.now = 10_300

    expect(attribution.userIdleFor('pty-1', LOOP_USER_IDLE_MS)).toBe(true)
  })

  it('tracks each pty separately', () => {
    const inputs = new Map<string, number>([['pty-a', 5_000]])
    const attribution = createInputAttribution(
      { terminalRunFacts: { readLastInputAt: (ptyId: string) => inputs.get(ptyId) ?? null } },
      { now: () => 6_000 }
    )

    expect(attribution.userInputSince('pty-a', 0)).toBe(true)
    expect(attribution.userInputSince('pty-b', 0)).toBe(false)
  })

  it('never throws and reports no user input when terminalRunFacts is missing', () => {
    const attribution = createInputAttribution({}, { now: () => 1_000 })

    expect(() => attribution.noteLoopWrite('pty-1', 500)).not.toThrow()
    expect(attribution.userInputSince('pty-1', 0)).toBe(false)
    expect(attribution.userIdleFor('pty-1', LOOP_USER_IDLE_MS)).toBe(true)
  })

  it('never throws when readLastInputAt is missing or throws', () => {
    const missing = createInputAttribution({ terminalRunFacts: {} }, { now: () => 1_000 })
    const throwing = createInputAttribution(
      {
        terminalRunFacts: {
          readLastInputAt: () => {
            throw new Error('boom')
          }
        }
      },
      { now: () => 1_000 }
    )

    expect(missing.userInputSince('pty-1', 0)).toBe(false)
    expect(throwing.userInputSince('pty-1', 0)).toBe(false)
    expect(throwing.userIdleFor('pty-1', 1)).toBe(true)
  })

  it('stops swallowing user input once an unclosed write window expires', () => {
    const { state, runtime } = runtimeWithInput()
    const { time, now } = clock(10_000)
    const attribution = createInputAttribution(runtime, { now })

    attribution.noteLoopWrite('pty-1', 10_000)
    time.now = 10_000 + 120_000
    state.lastInputAt = time.now - 1_000

    expect(attribution.userInputSince('pty-1', 10_000)).toBe(true)
  })
})
