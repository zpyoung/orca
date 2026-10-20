import {
  isDeniedScriptEnvName,
  SCRIPT_ENV_NAME_PATTERN
} from '../../shared/fork-heimdall-pipeline/script-env'
import {
  OBJECTIVE_CHECK_OUTPUT_TAIL_CHARS,
  runCriterionCheck
} from '../fork-heimdall-objective/check-runner'
import type { ObjectiveWorkspaceTarget } from '../fork-heimdall-objective/content-identity'

export class ScriptEnvRejectedError extends Error {
  constructor(name: string) {
    super(`Script environment variable is not allowed: ${name}`)
    this.name = 'ScriptEnvRejectedError'
  }
}

function assertAllowedScriptEnv(env: Record<string, string>): void {
  for (const name of Object.keys(env)) {
    if (!SCRIPT_ENV_NAME_PATTERN.test(name) || isDeniedScriptEnvName(name)) {
      throw new ScriptEnvRejectedError(name)
    }
  }
}

export async function runScriptNode(input: {
  command: string
  env: Record<string, string>
  timeoutSeconds: number
  target: ObjectiveWorkspaceTarget
}): Promise<{
  exitCode: number | null
  passed: boolean
  stdout: { text: string; truncated: boolean }
  stderrTail: string
  timedOut: boolean
  error: string | null
}> {
  assertAllowedScriptEnv(input.env)
  const result = await runCriterionCheck({
    command: input.command,
    target: input.target,
    timeoutSeconds: input.timeoutSeconds,
    preserveCommand: true,
    extraEnv: input.env
  })
  const stdoutText =
    result.stdoutTail.length <= OBJECTIVE_CHECK_OUTPUT_TAIL_CHARS
      ? result.stdoutTail
      : result.stdoutTail.slice(-OBJECTIVE_CHECK_OUTPUT_TAIL_CHARS)

  return {
    exitCode: result.exitCode,
    passed: result.pass,
    stdout: {
      text: stdoutText,
      truncated:
        result.stdoutTruncated === true ||
        result.stdoutTail.length > OBJECTIVE_CHECK_OUTPUT_TAIL_CHARS
    },
    stderrTail: result.stderrTail,
    timedOut: result.timedOut,
    error: result.error
  }
}
