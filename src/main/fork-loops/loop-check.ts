import type { AutomationPrecheckResult } from '../../shared/automations-types'
import type { CheckOutcome, LoopConfig } from '../../shared/fork-loops/loop-types'
import { runAutomationPrecheck } from '../automations/precheck-runner'

export const LOOP_CHECK_DEFAULT_TIMEOUT_SECONDS = 300
export const LOOP_CHECK_MAX_TIMEOUT_SECONDS = 600
export const LOOP_CHECK_OUTPUT_TAIL_CHARS = 4000

export type LoopCheckTarget =
  | { type: 'local'; cwd: string }
  | {
      type: 'ssh'
      cwd: string
      connectionId: string
      /** Undefined while the host's platform is not yet known. */
      remotePlatform: string | undefined
    }

export type LoopCheckDeps = {
  runPrecheck: (args: {
    precheck: { command: string; timeoutSeconds: number }
    target: { type: 'local'; cwd: string } | { type: 'ssh'; cwd: string; connectionId: string }
  }) => Promise<AutomationPrecheckResult>
}

export type LoopCheckHostVerdict =
  | { ok: true }
  | { ok: false; code: 'loop_check_unsupported_host'; message: string }

const WINDOWS_SSH_UNSUPPORTED = 'Loop checks do not support the Windows SSH command dialect.'

const defaultDeps: LoopCheckDeps = { runPrecheck: runAutomationPrecheck }

/** Whether a check can run on this host; `create` rejects with the returned code when it cannot. */
export function validateLoopCheckHost(target: LoopCheckTarget): LoopCheckHostVerdict {
  if (target.type === 'ssh' && target.remotePlatform === 'win32') {
    return { ok: false, code: 'loop_check_unsupported_host', message: WINDOWS_SSH_UNSUPPORTED }
  }
  return { ok: true }
}

function clampTimeoutSeconds(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return LOOP_CHECK_DEFAULT_TIMEOUT_SECONDS
  }
  return Math.min(Math.floor(value), LOOP_CHECK_MAX_TIMEOUT_SECONDS)
}

function notRun(error: string): CheckOutcome {
  return {
    ran: false,
    pass: false,
    exitCode: null,
    timedOut: false,
    stdoutTail: '',
    stderrTail: '',
    durationMs: 0,
    error
  }
}

/**
 * Runs the loop's done-check on its execution host and reports the result as evidence. Never
 * throws: every failure becomes `error` on the outcome so the driver's decision stays total.
 */
export async function runLoopCheck(
  loop: { config: Pick<LoopConfig, 'done'> },
  target: LoopCheckTarget,
  deps: LoopCheckDeps = defaultDeps
): Promise<CheckOutcome> {
  const check = loop.config.done.check
  if (!check) {
    return notRun('no-check-configured')
  }
  const hostVerdict = validateLoopCheckHost(target)
  if (!hostVerdict.ok) {
    return notRun(hostVerdict.message)
  }
  try {
    const executionTarget =
      target.type === 'ssh'
        ? { type: 'ssh' as const, cwd: target.cwd, connectionId: target.connectionId }
        : target
    const result = await deps.runPrecheck({
      precheck: {
        command: check.command,
        timeoutSeconds: clampTimeoutSeconds(check.timeoutSeconds)
      },
      target: executionTarget
    })
    const started = result.timedOut || result.exitCode !== null || result.error === null
    return {
      ran: started,
      pass: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdoutTail: result.stdout.slice(-LOOP_CHECK_OUTPUT_TAIL_CHARS),
      stderrTail: result.stderr.slice(-LOOP_CHECK_OUTPUT_TAIL_CHARS),
      durationMs: result.durationMs,
      ...(result.error === null ? {} : { error: result.error })
    }
  } catch (error) {
    return notRun(error instanceof Error ? error.message : String(error))
  }
}
