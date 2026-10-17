import { describe, expect, it, vi } from 'vitest'
import type { AutomationPrecheckResult } from '../../shared/automations-types'
import {
  LOOP_CHECK_DEFAULT_TIMEOUT_SECONDS,
  LOOP_CHECK_MAX_TIMEOUT_SECONDS,
  LOOP_CHECK_OUTPUT_TAIL_CHARS,
  runLoopCheck,
  validateLoopCheckHost,
  type LoopCheckTarget
} from './loop-check'

const LOCAL: LoopCheckTarget = { type: 'local', cwd: '/work' }

function loopWithCheck(check?: {
  command: string
  timeoutSeconds: number
  runWhen: 'every-iteration' | 'on-claim'
}) {
  return { config: { done: check ? { check } : {} } }
}

function precheckResult(overrides: Partial<AutomationPrecheckResult>): AutomationPrecheckResult {
  return {
    command: 'pnpm test',
    exitCode: 0,
    timedOut: false,
    durationMs: 12,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    error: null,
    startedAt: 1,
    completedAt: 13,
    ...overrides
  }
}

describe('runLoopCheck', () => {
  const check = { command: 'pnpm test', timeoutSeconds: 120, runWhen: 'every-iteration' } as const

  it('maps a zero exit to a passing outcome and forwards the command and timeout', async () => {
    const runPrecheck = vi.fn(async () => precheckResult({ stdout: 'ok', stderr: 'warn' }))
    const outcome = await runLoopCheck(loopWithCheck(check), LOCAL, { runPrecheck })
    expect(outcome).toEqual({
      ran: true,
      pass: true,
      exitCode: 0,
      timedOut: false,
      stdoutTail: 'ok',
      stderrTail: 'warn',
      durationMs: 12
    })
    expect(runPrecheck).toHaveBeenCalledWith({
      precheck: { command: 'pnpm test', timeoutSeconds: 120 },
      target: LOCAL
    })
  })

  it('maps a non-zero exit to a failing outcome that still ran', async () => {
    const outcome = await runLoopCheck(loopWithCheck(check), LOCAL, {
      runPrecheck: async () => precheckResult({ exitCode: 3 })
    })
    expect(outcome).toMatchObject({ ran: true, pass: false, exitCode: 3, timedOut: false })
  })

  it('marks a timeout as ran, failing, and carries the error text', async () => {
    const outcome = await runLoopCheck(loopWithCheck(check), LOCAL, {
      runPrecheck: async () =>
        precheckResult({ exitCode: null, timedOut: true, error: 'Precheck timed out after 120s.' })
    })
    expect(outcome).toMatchObject({
      ran: true,
      pass: false,
      exitCode: null,
      timedOut: true,
      error: 'Precheck timed out after 120s.'
    })
  })

  it('reports a spawn failure as not run', async () => {
    const outcome = await runLoopCheck(loopWithCheck(check), LOCAL, {
      runPrecheck: async () =>
        precheckResult({ exitCode: null, error: 'SSH target is not connected.' })
    })
    expect(outcome).toMatchObject({
      ran: false,
      pass: false,
      exitCode: null,
      error: 'SSH target is not connected.'
    })
  })

  it('caps each output tail at the evidence limit, keeping the end', async () => {
    const long = `${'a'.repeat(LOOP_CHECK_OUTPUT_TAIL_CHARS)}END`
    const outcome = await runLoopCheck(loopWithCheck(check), LOCAL, {
      runPrecheck: async () => precheckResult({ stdout: long, stderr: long })
    })
    expect(outcome.stdoutTail).toHaveLength(LOOP_CHECK_OUTPUT_TAIL_CHARS)
    expect(outcome.stdoutTail.endsWith('END')).toBe(true)
    expect(outcome.stderrTail).toHaveLength(LOOP_CHECK_OUTPUT_TAIL_CHARS)
  })

  it('clamps the timeout to the maximum and defaults a missing or invalid one', async () => {
    const seen: number[] = []
    const runPrecheck = async (args: { precheck: { timeoutSeconds: number } }) => {
      seen.push(args.precheck.timeoutSeconds)
      return precheckResult({})
    }
    await runLoopCheck(loopWithCheck({ ...check, timeoutSeconds: 9999 }), LOCAL, { runPrecheck })
    await runLoopCheck(loopWithCheck({ ...check, timeoutSeconds: 0 }), LOCAL, { runPrecheck })
    expect(seen).toEqual([LOOP_CHECK_MAX_TIMEOUT_SECONDS, LOOP_CHECK_DEFAULT_TIMEOUT_SECONDS])
  })

  it('never throws when the runner rejects', async () => {
    const outcome = await runLoopCheck(loopWithCheck(check), LOCAL, {
      runPrecheck: async () => {
        throw new Error('boom')
      }
    })
    expect(outcome).toMatchObject({ ran: false, pass: false, error: 'boom' })
  })

  it('reports a loop with no check configured as not run without invoking the runner', async () => {
    const runPrecheck = vi.fn()
    const outcome = await runLoopCheck(loopWithCheck(), LOCAL, { runPrecheck })
    expect(outcome).toMatchObject({ ran: false, pass: false })
    expect(outcome.error).toBeDefined()
    expect(runPrecheck).not.toHaveBeenCalled()
  })

  it('refuses to run on a Windows SSH host', async () => {
    const runPrecheck = vi.fn()
    const outcome = await runLoopCheck(
      loopWithCheck(check),
      { type: 'ssh', cwd: 'C:\\work', connectionId: 'c1', remotePlatform: 'win32' },
      { runPrecheck }
    )
    expect(outcome).toMatchObject({ ran: false, pass: false })
    expect(outcome.error).toContain('Windows')
    expect(runPrecheck).not.toHaveBeenCalled()
  })
})

describe('runLoopCheck abort', () => {
  const check = { command: 'pnpm test', timeoutSeconds: 120, runWhen: 'every-iteration' } as const

  it('does not start a check when the signal is already aborted', async () => {
    const runPrecheck = vi.fn()
    const controller = new AbortController()
    controller.abort()

    const outcome = await runLoopCheck(
      loopWithCheck(check),
      LOCAL,
      { runPrecheck },
      controller.signal
    )

    expect(outcome).toMatchObject({ ran: false, pass: false, error: 'aborted' })
    expect(runPrecheck).not.toHaveBeenCalled()
  })

  it('hands the signal to the runner and reports not run only after the runner has stopped', async () => {
    const controller = new AbortController()
    let runnerStopped = false
    const runPrecheck = vi.fn(
      ({ signal }: { signal?: AbortSignal }) =>
        new Promise<AutomationPrecheckResult>((resolve) => {
          signal?.addEventListener('abort', () => {
            setTimeout(() => {
              runnerStopped = true
              resolve(precheckResult({ exitCode: null, error: 'aborted' }))
            }, 10)
          })
        })
    )

    const pending = runLoopCheck(loopWithCheck(check), LOCAL, { runPrecheck }, controller.signal)
    controller.abort()
    const outcome = await pending

    expect(runPrecheck.mock.calls[0][0].signal).toBe(controller.signal)
    expect(runnerStopped).toBe(true)
    expect(outcome).toMatchObject({ ran: false, pass: false, error: 'aborted' })
  })

  it('reports a finished check normally when the signal never aborts', async () => {
    const runPrecheck = vi.fn(async () => precheckResult({}))
    const controller = new AbortController()

    const outcome = await runLoopCheck(
      loopWithCheck(check),
      LOCAL,
      { runPrecheck },
      controller.signal
    )

    expect(outcome).toMatchObject({ ran: true, pass: true })
  })
})

describe('validateLoopCheckHost', () => {
  it('rejects a Windows SSH host with loop_check_unsupported_host', () => {
    expect(
      validateLoopCheckHost({ type: 'ssh', cwd: '/x', connectionId: 'c', remotePlatform: 'win32' })
    ).toMatchObject({ ok: false, code: 'loop_check_unsupported_host' })
  })

  it('accepts local and POSIX SSH hosts', () => {
    expect(validateLoopCheckHost(LOCAL)).toEqual({ ok: true })
    expect(
      validateLoopCheckHost({ type: 'ssh', cwd: '/x', connectionId: 'c', remotePlatform: 'linux' })
    ).toEqual({ ok: true })
  })
})
