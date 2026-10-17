import { describe, expect, it } from 'vitest'
import type { CheckOutcome, LoopConfig } from './loop-types'
import { parseLoopMarkers } from './loop-markers'
import { composeIterationPrompt, LOOP_PREAMBLE } from './loop-prompt'

const loop: LoopConfig = {
  promptSource: { kind: 'repeat', body: 'do the thing' },
  pacing: { kind: 'on-idle' },
  sessionPolicy: 'fresh',
  done: {},
  caps: {},
  noProgress: false,
  checkpointCommits: false,
  askBeforeNext: false,
  resumeAtLimitReset: false
}

const failedCheck = (stdoutTail: string, stderrTail = ''): CheckOutcome => ({
  ran: true,
  pass: false,
  exitCode: 1,
  timedOut: false,
  stdoutTail,
  stderrTail,
  durationMs: 10
})

const compose = (overrides: Partial<Parameters<typeof composeIterationPrompt>[0]> = {}): string =>
  composeIterationPrompt({
    loop,
    iteration: 3,
    maxIterations: 10,
    previousCheck: null,
    steerNotes: [],
    body: 'BODY TEXT',
    notesPath: '/tmp/notes.md',
    includePreamble: false,
    ...overrides
  })

describe('composeIterationPrompt', () => {
  it('states the iteration with a cap', () => {
    expect(compose()).toContain('iteration 3 of 10')
  })

  it('states the iteration without a cap', () => {
    const out = compose({ maxIterations: null })
    expect(out).toContain('iteration 3')
    expect(out).not.toContain('iteration 3 of')
  })

  it('includes the body', () => {
    expect(compose()).toContain('BODY TEXT')
  })

  it('appends only the last 40 lines of a failed previous check', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`)
    const out = compose({ previousCheck: failedCheck(lines.join('\n')) })
    expect(out).toContain('line-99')
    expect(out).toContain('line-60')
    expect(out).not.toContain('line-59\n')
    expect(out).not.toMatch(/line-59$/m)
  })

  it('omits check output when the previous check passed or is absent', () => {
    expect(compose()).not.toContain('previous check')
    const passed: CheckOutcome = { ...failedCheck('ok-output'), pass: true, exitCode: 0 }
    const out = compose({ previousCheck: passed })
    expect(out).not.toContain('ok-output')
  })

  it('lists steer notes in order', () => {
    const out = compose({ steerNotes: ['first note', 'second note'] })
    expect(out.indexOf('first note')).toBeGreaterThan(-1)
    expect(out.indexOf('second note')).toBeGreaterThan(out.indexOf('first note'))
  })

  it('includes the preamble only when requested', () => {
    expect(compose()).not.toContain(LOOP_PREAMBLE)
    const withPreamble = compose({ includePreamble: true })
    expect(withPreamble).toContain(LOOP_PREAMBLE.split('\n')[0])
    expect(withPreamble).toContain('/tmp/notes.md')
  })

  it('never yields a marker from the composed prompt', () => {
    const out = compose({
      includePreamble: true,
      previousCheck: failedCheck('boom'),
      steerNotes: ['n']
    })
    expect(parseLoopMarkers(out)).toEqual([])
  })
})
