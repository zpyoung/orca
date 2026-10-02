import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { PipelineAgentNode } from '../../shared/fork-heimdall-pipeline/document-schema'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'
import {
  createReportValidationProvenance,
  type ActionOutcome,
  type EffectCertaintyResolution,
  type ReportValidationCode
} from '../../shared/fork-heimdall/effect-certainty'
import type { AttemptEntry } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type {
  DispatchResult,
  DispatchWorkerRequest
} from '../../shared/fork-heimdall/kind-contract'
import { ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES } from '../../shared/orchestration-worker-start-prompt-budget'
import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'
import type { PipelineStore } from './pipeline-store'
import {
  captureProtectedDigest,
  compareProtectedDigest,
  parseProtectedDigest,
  PROTECTED_PIPELINE_OVER_CAP_PATH,
  type ProtectedDigest
} from './protected-pipeline-files'
import { pipelineReportInstructions } from './pipeline-report-instructions'
import { issuePipelineReportPath, type PipelineWorkspaceTarget } from './pipeline-report-path'
import { readPipelineReport, validatePipelineReport } from './pipeline-report-ingestion'

const PipelineNodeIdentitySchema = z
  .object({
    instanceId: z.string().min(1),
    nodeId: z.string().min(1),
    epoch: z.number().int().nonnegative(),
    attempt: z.number().int().nonnegative()
  })
  .passthrough()

export type PipelineAgentAttemptIdentity = Readonly<z.infer<typeof PipelineNodeIdentitySchema>>
export type PipelineAgentReportActionKind =
  | 'pipeline-dispatch-agent'
  | 'pipeline-resolve-merge-conflict'

/** Selects native worker actions that use the pipeline Agent report contract. */
export function isPipelineAgentReportActionKind(
  kind: string
): kind is PipelineAgentReportActionKind {
  return kind === 'pipeline-dispatch-agent' || kind === 'pipeline-resolve-merge-conflict'
}

export type PipelineAgentDispatchFact = Readonly<PipelineStoreFacts['dispatches'][number]>
export type PipelineAgentBaselineFact = Readonly<{ workspacePath: string; digest: unknown }>

export type PipelineAgentReportContext = Readonly<{
  target: PipelineWorkspaceTarget
  node: PipelineAgentNode
  fileExists(relPath: string): Promise<boolean>
}>

export type ResolvePipelineAgentReportContextInput = Readonly<{
  enrollment?: WatcherEnrollment
  attempt: AttemptEntry
  dispatch: PipelineAgentDispatchFact
  baseline: PipelineAgentBaselineFact
}>

export type ResolvePipelineAgentReportContext = (
  input: ResolvePipelineAgentReportContextInput
) => Promise<PipelineAgentReportContext>

export type DispatchAgentNodeInput = Readonly<{
  watcherId: string
  node: PipelineAgentNode
  instanceId: string
  epoch: number
  attempt: number
  attemptFingerprint: string
  renderedPrompt: string
  harness: string
  model?: string
  effort?: string
  target: PipelineWorkspaceTarget
}>

export type DispatchAgentNodeDependencies = Readonly<{
  dispatchWorker(request: DispatchWorkerRequest): Promise<DispatchResult>
  store: PipelineStore
  captureDigest?: typeof captureProtectedDigest
  nowMs(): number
}>

export type ResolveAgentAttemptDependencies = Readonly<{
  store: PipelineStore
  resolveReportContext: ResolvePipelineAgentReportContext
  captureDigest?: typeof captureProtectedDigest
  nowMs(): number
}>

/** Extracts the private node identity only from actions using the pipeline Agent report contract. */
export function pipelineAgentAttemptIdentity(
  attempt: AttemptEntry
): PipelineAgentAttemptIdentity | null {
  if (!isPipelineAgentReportActionKind(attempt.action.kind)) {
    return null
  }
  const parsed = PipelineNodeIdentitySchema.safeParse(attempt.action.pipelineNode)
  return parsed.success ? parsed.data : null
}

function reportValidation(
  dispatch: PipelineAgentDispatchFact,
  taskKey: string,
  code: ReportValidationCode,
  detail: string,
  status: 'rejected' | 'unverifiable',
  hostVerifiable: boolean,
  observedFiles: readonly string[] = []
) {
  return createReportValidationProvenance({
    status,
    code,
    role: 'implementer',
    dispatchId: dispatch.dispatchId,
    taskKey,
    reportPath: dispatch.reportPath,
    detail,
    observedFiles,
    hostVerifiable
  })
}

function criteriaFailure(
  dispatch: PipelineAgentDispatchFact,
  taskKey: string,
  code: ReportValidationCode,
  detail: string,
  observedFiles: readonly string[] = []
): EffectCertaintyResolution {
  return {
    effect: 'not-landed',
    failureClass: 'criteria',
    reportValidation: reportValidation(
      dispatch,
      taskKey,
      code,
      detail,
      'rejected',
      true,
      observedFiles
    )
  }
}

function indeterminateReport(
  dispatch: PipelineAgentDispatchFact,
  taskKey: string,
  detail: string,
  code: ReportValidationCode = 'read-unverifiable'
): EffectCertaintyResolution {
  return {
    effect: 'indeterminate',
    reportValidation: reportValidation(dispatch, taskKey, code, detail, 'unverifiable', false)
  }
}

function dispatchRowFor(
  store: PipelineStore,
  attempt: AttemptEntry,
  identity: PipelineAgentAttemptIdentity
): PipelineAgentDispatchFact | null {
  return (
    store
      .facts(attempt.watcherId)
      .dispatches.find(
        (dispatch) =>
          dispatch.instanceId === identity.instanceId &&
          dispatch.epoch === identity.epoch &&
          dispatch.attempt === identity.attempt &&
          (attempt.dispatchId === undefined || dispatch.dispatchId === attempt.dispatchId)
      ) ?? null
  )
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Captures an attempt baseline, dispatches the Agent, and records successful dispatch facts. */
export async function dispatchAgentNode(
  input: DispatchAgentNodeInput,
  deps: DispatchAgentNodeDependencies
): Promise<ActionOutcome> {
  let reportPath: string
  try {
    reportPath = issuePipelineReportPath(input.target, input.attemptFingerprint)
  } catch (error) {
    return {
      effect: 'not-landed',
      failureClass: 'infra',
      reason: errorText(error)
    }
  }
  const spec = `${input.renderedPrompt}\n\n${pipelineReportInstructions({
    reportPath,
    nodeId: input.node.id,
    outputs: input.node.outputs ?? {}
  })}`
  const promptSize = measureUtf8ByteLength(spec, {
    stopAfterBytes: ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES
  })
  if (promptSize.byteLength > ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES) {
    return {
      effect: 'not-landed',
      failureClass: 'criteria',
      reason: `Rendered worker task spec exceeds ${ORCHESTRATION_WORKER_START_TASK_SPEC_MAX_BYTES} UTF-8 bytes.`
    }
  }

  try {
    const baseline = await (deps.captureDigest ?? captureProtectedDigest)(input.target)
    deps.store.recordAttemptBaseline({
      watcherId: input.watcherId,
      attemptFingerprint: input.attemptFingerprint,
      workspacePath: input.target.workspacePath,
      digest: baseline
    })
  } catch (error) {
    return {
      effect: 'not-landed',
      failureClass: 'infra',
      reason: errorText(error)
    }
  }

  let result: DispatchResult
  try {
    result = await deps.dispatchWorker({
      spec,
      agent: input.harness,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.effort === undefined ? {} : { effort: input.effort }),
      taskKey: input.instanceId,
      ...(input.target.workspaceId === undefined ? {} : { workspaceId: input.target.workspaceId })
    })
  } catch (error) {
    return {
      effect: 'not-landed',
      failureClass: 'infra',
      reason: errorText(error)
    }
  }
  if (result.status === 'refused') {
    return {
      effect: 'not-landed',
      failureClass: 'infra',
      reason: result.reason,
      result: { detail: result.detail }
    }
  }
  if (result.status === 'indeterminate') {
    return { effect: 'indeterminate', reason: 'dispatch-indeterminate', result }
  }

  try {
    deps.store.recordDispatch({
      watcherId: input.watcherId,
      instanceId: input.instanceId,
      epoch: input.epoch,
      attempt: input.attempt,
      dispatchId: result.dispatchId,
      workspaceId: input.target.workspaceId ?? null,
      terminalHandle: result.terminalHandle ?? null,
      reportPath,
      dispatchedAtMs: deps.nowMs()
    })
  } catch (error) {
    return {
      effect: 'indeterminate',
      reason: `dispatch-record-unverifiable: ${errorText(error)}`,
      result: {
        dispatchId: result.dispatchId,
        reportPath,
        ...(result.terminalHandle === undefined ? {} : { terminalHandle: result.terminalHandle })
      }
    }
  }
  return {
    effect: 'landed',
    result: {
      dispatchId: result.dispatchId,
      reportPath,
      ...(result.terminalHandle === undefined ? {} : { terminalHandle: result.terminalHandle })
    }
  }
}

/** Resolves a completed Agent attempt from its recorded dispatch, report, and protected digest. */
export async function resolveAgentAttempt(
  attempt: AttemptEntry,
  deps: ResolveAgentAttemptDependencies
): Promise<EffectCertaintyResolution> {
  const identity = pipelineAgentAttemptIdentity(attempt)
  if (!identity) {
    return { effect: 'indeterminate' }
  }
  const dispatch = dispatchRowFor(deps.store, attempt, identity)
  if (!dispatch) {
    return { effect: 'indeterminate' }
  }
  const baseline = deps.store.attemptBaseline(attempt.watcherId, attempt.fingerprint)
  if (!baseline) {
    return { effect: 'indeterminate' }
  }
  const before = parseProtectedDigest(baseline.digest)
  if (!before) {
    return { effect: 'indeterminate' }
  }
  if (before.status === 'over-cap') {
    return criteriaFailure(
      dispatch,
      identity.instanceId,
      'evidence-mismatch',
      `protected-path-modified:${PROTECTED_PIPELINE_OVER_CAP_PATH}`,
      [PROTECTED_PIPELINE_OVER_CAP_PATH]
    )
  }

  let reportContext: PipelineAgentReportContext
  try {
    reportContext = await deps.resolveReportContext({ attempt, dispatch, baseline })
  } catch {
    return { effect: 'indeterminate' }
  }
  if (
    reportContext.target.workspacePath !== baseline.workspacePath ||
    (dispatch.workspaceId !== null && reportContext.target.workspaceId !== dispatch.workspaceId)
  ) {
    return { effect: 'indeterminate' }
  }
  let expectedReportPath: string
  try {
    expectedReportPath = issuePipelineReportPath(reportContext.target, attempt.fingerprint)
  } catch {
    return { effect: 'indeterminate' }
  }
  if (dispatch.reportPath !== expectedReportPath || reportContext.node.id !== identity.nodeId) {
    return { effect: 'indeterminate' }
  }

  let after: ProtectedDigest
  try {
    after = await (deps.captureDigest ?? captureProtectedDigest)(reportContext.target)
  } catch {
    return { effect: 'indeterminate' }
  }
  const changed = compareProtectedDigest(before, after).changed
  if (changed.length > 0) {
    const modifiedReason = `protected-path-modified:${changed[0]}`
    return criteriaFailure(
      dispatch,
      identity.instanceId,
      'evidence-mismatch',
      modifiedReason,
      changed
    )
  }

  const read = await readPipelineReport(dispatch.reportPath, {
    ...reportContext.target,
    attemptFingerprint: attempt.fingerprint
  })
  if (read.status === 'missing') {
    return criteriaFailure(dispatch, identity.instanceId, 'missing', 'Agent report is missing.')
  }
  if (read.status === 'unverifiable') {
    if (read.reason === 'oversize') {
      return criteriaFailure(
        dispatch,
        identity.instanceId,
        'oversize',
        'Agent report exceeds the 256 KiB limit.'
      )
    }
    return indeterminateReport(dispatch, identity.instanceId, read.reason)
  }

  let raw: unknown
  try {
    raw = JSON.parse(read.bytes.toString('utf8'))
  } catch {
    return criteriaFailure(
      dispatch,
      identity.instanceId,
      'malformed',
      'Agent report is not valid JSON.'
    )
  }
  let validation
  try {
    validation = await validatePipelineReport(raw, reportContext.node, reportContext.fileExists)
  } catch (error) {
    return indeterminateReport(dispatch, identity.instanceId, errorText(error))
  }
  if (!validation.ok) {
    return criteriaFailure(dispatch, identity.instanceId, 'semantic-invalid', validation.error)
  }
  try {
    deps.store.recordNodeOutput({
      watcherId: attempt.watcherId,
      instanceId: identity.instanceId,
      epoch: identity.epoch,
      attempt: identity.attempt,
      outputs: validation.report.outputs,
      reportSha256: createHash('sha256').update(read.bytes).digest('hex'),
      reportSummary: validation.report.summary,
      nowMs: deps.nowMs()
    })
  } catch {
    return { effect: 'indeterminate' }
  }
  return { effect: 'landed' }
}
