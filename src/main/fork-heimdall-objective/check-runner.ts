import { runAutomationPrecheck } from '../automations/precheck-runner'
import { runtimeFileSshTargetId } from '../runtime/runtime-file-command-target'
import { getRegisteredSshState } from '../ssh/ssh-target-registry'
import type { ObjectiveWorkspaceTarget } from './content-identity'

export const OBJECTIVE_CHECK_TIMEOUT_SECONDS = 300
export const OBJECTIVE_CHECK_OUTPUT_TAIL_CHARS = 4 * 1024

export type CriterionCheckResult = {
  command: string
  pass: boolean
  exitCode: number | null
  timedOut: boolean
  stdoutTail: string
  stderrTail: string
  error: string | null
  startedAtMs: number
  completedAtMs: number
  durationMs: number
}

type CriterionCheckExecutionTarget =
  | { type: 'local'; cwd: string }
  | { type: 'ssh'; cwd: string; connectionId: string }

function unsupportedSshDialectResult(command: string, error: string): CriterionCheckResult {
  const startedAtMs = Date.now()
  const completedAtMs = Date.now()
  return {
    command,
    pass: false,
    exitCode: null,
    timedOut: false,
    stdoutTail: '',
    stderrTail: '',
    error,
    startedAtMs,
    completedAtMs,
    durationMs: Math.max(0, completedAtMs - startedAtMs)
  }
}

export async function runCriterionCheck(args: {
  command: string
  target: ObjectiveWorkspaceTarget
  timeoutSeconds?: number
}): Promise<CriterionCheckResult> {
  const command = args.command.trim()
  if (!command) {
    throw new Error('Criterion check command cannot be empty')
  }
  const timeoutSeconds = args.timeoutSeconds ?? OBJECTIVE_CHECK_TIMEOUT_SECONDS
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('Criterion check timeout must be a positive integer number of seconds')
  }

  const sshTargetId = runtimeFileSshTargetId(args.target)
  let executionTarget: CriterionCheckExecutionTarget
  if (args.target.fileProvider === null) {
    if (sshTargetId !== undefined || args.target.executionHostId !== 'local') {
      throw new Error('Remote criterion check target has no filesystem provider')
    }
    executionTarget = { type: 'local', cwd: args.target.workspacePath }
  } else {
    if (sshTargetId === undefined) {
      throw new Error('Criterion check filesystem provider is not SSH-routable')
    }
    executionTarget = {
      type: 'ssh',
      cwd: args.target.workspacePath,
      connectionId: sshTargetId
    }
    const remotePlatform = getRegisteredSshState(sshTargetId)?.remotePlatform
    if (remotePlatform === 'win32') {
      return unsupportedSshDialectResult(
        command,
        'Criterion check preflight does not support the Windows SSH command dialect.'
      )
    }
    if (remotePlatform === undefined) {
      return unsupportedSshDialectResult(
        command,
        'Criterion check preflight cannot select an SSH command dialect because the host platform is unavailable.'
      )
    }
  }

  const result = await runAutomationPrecheck({
    precheck: { command, timeoutSeconds },
    target: executionTarget
  })
  return {
    command: result.command,
    pass: result.exitCode === 0 && result.timedOut === false,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdoutTail: result.stdout.slice(-OBJECTIVE_CHECK_OUTPUT_TAIL_CHARS),
    stderrTail: result.stderr.slice(-OBJECTIVE_CHECK_OUTPUT_TAIL_CHARS),
    error: result.error,
    startedAtMs: result.startedAt,
    completedAtMs: result.completedAt,
    durationMs: result.durationMs
  }
}
