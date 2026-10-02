import type { PipelineOutputType } from '../../shared/fork-heimdall-pipeline/document-schema'
import { ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES } from '../../shared/orchestration-worker-start-prompt-budget'
import { MAX_PIPELINE_REPORT_BYTES } from './pipeline-report-path'

function outputTypeDescription(type: PipelineOutputType): string {
  switch (type.type) {
    case 'text':
      return 'text (JSON string)'
    case 'number':
      return 'number (JSON number)'
    case 'boolean':
      return 'boolean (JSON boolean)'
    case 'json':
      return 'json (any JSON value)'
    case 'file':
      return 'file (worktree-relative path to an existing file)'
    case 'taskList':
      return 'taskList (1-20 JSON tasks: id, title ≤200 characters, spec ≤16384 characters, optional deps and territory)'
    case 'verdict':
      return 'verdict ({verdict: approve|revise|escalate, optional reason ≤4000 characters and objections ≤50 strings})'
    case 'enum':
      return `enum (one of ${JSON.stringify(type.values)})`
  }
}

/** Renders the strict Agent report schema and worker_done instructions for one attempt. */
export function pipelineReportInstructions(
  input: Readonly<{
    reportPath: string
    nodeId: string
    outputs: Record<string, PipelineOutputType>
  }>
): string {
  const declaredOutputs = Object.entries(input.outputs).sort(([left], [right]) =>
    left.localeCompare(right)
  )
  const outputNames = declaredOutputs.map(([name]) => name)
  const outputLines = declaredOutputs.map(
    ([name, type]) => `- ${JSON.stringify(name)}: ${outputTypeDescription(type)}`
  )
  if (outputLines.length === 0) {
    outputLines.push('- No outputs are declared; use an empty object.')
  }
  const reportExample = JSON.stringify({
    nodeId: input.nodeId,
    summary: '<summary ≤4000 characters>',
    outputs: {}
  })
  return [
    '## Report instructions',
    `Write the strict JSON report atomically to this exact absolute path: ${JSON.stringify(input.reportPath)}`,
    `The report must be exactly {nodeId, summary, outputs}: nodeId must be ${JSON.stringify(input.nodeId)}, summary is a string of at most 4000 characters, and outputs must contain every declared output and no other keys.`,
    `JSON shape: ${reportExample}`,
    `Required output keys in outputs: ${JSON.stringify(outputNames)}.`,
    ...outputLines,
    `The complete report file is limited to ${MAX_PIPELINE_REPORT_BYTES} UTF-8 bytes.`,
    `The worker-start task prompt is independently limited to ${ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES} UTF-8 bytes before dispatch.`,
    'Then finish using the worker identifiers Orca supplied in your preamble:',
    `orca orchestration send --from <workerHandle> --type worker_done --outcome succeeded --task-id <taskId> --dispatch-id <dispatchId> --report-path ${JSON.stringify(input.reportPath)} [--files-modified a,b,c] --subject "<one line>" --body "<brief completion notification; do not copy the full report summary>"`,
    'Orca validates the report before accepting worker_done.',
    'Correct this same report file and resend the same worker_done command only when lifecycle.action is "rejected" and either lifecycle.authority is "run_home", or lifecycle.code is "heimdall_report_invalid" and its local/direct preflight reason explicitly says this Dispatch is still active.',
    'A terminal or legacy receipt such as {action:"completed",authority:"worker_server_legacy"}, or any rejection without one of those active confirmations, is not corrective authorization. Do not resend or self-redispatch; await owner review and an owner-authorized fresh Dispatch after live work is ruled out.',
    'If the work itself failed, still write the most complete valid report possible and send worker_done with --outcome failed.'
  ].join('\n')
}
