import {
  OBJECTIVE_CHECK_OUTPUT_TAIL_CHARS,
  runCriterionCheck
} from '../fork-heimdall-objective/check-runner'
import type { ObjectiveWorkspaceTarget } from '../fork-heimdall-objective/content-identity'

export async function runCheckNode(input: {
  command: string
  timeoutSeconds: number
  target: ObjectiveWorkspaceTarget
}): Promise<{
  exitCode: number | null
  passed: boolean
  outputTail: string
  timedOut: boolean
  error: string | null
}> {
  const result = await runCriterionCheck({
    command: input.command,
    target: input.target,
    timeoutSeconds: input.timeoutSeconds,
    preserveCommand: true
  })
  const output = result.stderrTail
    ? `${result.stdoutTail}\n${result.stderrTail}`
    : result.stdoutTail
  const outputTail =
    output.length <= OBJECTIVE_CHECK_OUTPUT_TAIL_CHARS
      ? output
      : output.slice(-OBJECTIVE_CHECK_OUTPUT_TAIL_CHARS)

  return {
    exitCode: result.exitCode,
    passed: result.pass,
    outputTail,
    timedOut: result.timedOut,
    error: result.error
  }
}
