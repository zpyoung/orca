import { runAutomationPrecheck } from '../automations/precheck-runner'
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
  stdoutTruncated?: boolean
  startedAtMs: number
  completedAtMs: number
  durationMs: number
}

export async function runCriterionCheck(args: {
  command: string
  target: ObjectiveWorkspaceTarget
  timeoutSeconds?: number
  extraEnv?: NodeJS.ProcessEnv
  preserveCommand?: boolean
}): Promise<CriterionCheckResult> {
  const command = args.preserveCommand ? args.command : args.command.trim()
  if (!command.trim()) {
    throw new Error('Criterion check command cannot be empty')
  }
  const timeoutSeconds = args.timeoutSeconds ?? OBJECTIVE_CHECK_TIMEOUT_SECONDS
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error('Criterion check timeout must be a positive integer number of seconds')
  }

  if (args.target.executionHostId !== 'local') {
    throw new Error('Remote criterion check target is not served by this host')
  }

  const result = await runAutomationPrecheck({
    precheck: { command, timeoutSeconds },
    target: {
      type: 'local',
      cwd: args.target.workspacePath,
      ...(args.extraEnv !== undefined ? { extraEnv: args.extraEnv } : {})
    }
  })
  return {
    command: result.command,
    pass: result.exitCode === 0 && result.timedOut === false,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    stdoutTail: result.stdout.slice(-OBJECTIVE_CHECK_OUTPUT_TAIL_CHARS),
    stderrTail: result.stderr.slice(-OBJECTIVE_CHECK_OUTPUT_TAIL_CHARS),
    ...(result.stdoutTruncated ? { stdoutTruncated: true } : {}),
    error: result.error,
    startedAtMs: result.startedAt,
    completedAtMs: result.completedAt,
    durationMs: result.durationMs
  }
}
