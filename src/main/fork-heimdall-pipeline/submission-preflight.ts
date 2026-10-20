import type { SubmissionAdapter } from '../../shared/fork-heimdall/kind-contract'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { PipelineStore } from './pipeline-store'
import {
  isPipelineAgentReportActionKind,
  pipelineAgentAttemptIdentity,
  type PipelineAgentAttemptIdentity,
  type PipelineAgentDispatchFact,
  type PipelineAgentReportContext,
  type ResolvePipelineAgentReportContext
} from './agent-node-executor'
import {
  captureProtectedDigest,
  compareProtectedDigest,
  parseProtectedDigest
} from './protected-pipeline-files'
import { issuePipelineReportPath } from './pipeline-report-path'
import { readPipelineReport, validatePipelineReport } from './pipeline-report-ingestion'

const ACCEPTED = { status: 'accepted' } as const
const REPORT_INVALID_CODE = 'heimdall_report_invalid'

export type PipelineSubmissionPreflightDependencies = Readonly<{
  store: PipelineStore
  resolveReportContext: ResolvePipelineAgentReportContext
  captureDigest?: typeof captureProtectedDigest
}>

type ActiveAgentDispatch = Readonly<{
  attempt: AttemptEntry
  dispatch: PipelineAgentDispatchFact
  identity: PipelineAgentAttemptIdentity
}>
function activeAgentDispatch(
  ledger: WatcherLedger,
  dispatchId: string,
  store: PipelineStore
): ActiveAgentDispatch | null {
  for (let index = ledger.entries.length - 1; index >= 0; index -= 1) {
    const entry = ledger.entries[index]
    if (
      !entry ||
      entry.kind !== 'attempt' ||
      entry.watcherId !== ledger.watcherId ||
      !isPipelineAgentReportActionKind(entry.action.kind) ||
      entry.dispatchId !== dispatchId
    ) {
      continue
    }
    if (entry.state === 'settled') {
      return null
    }
    const identity = pipelineAgentAttemptIdentity(entry)
    if (!identity) {
      return null
    }
    const dispatch = store
      .facts(entry.watcherId)
      .dispatches.find(
        (fact) =>
          fact.dispatchId === dispatchId &&
          fact.instanceId === identity.instanceId &&
          fact.epoch === identity.epoch &&
          fact.attempt === identity.attempt
      )
    return dispatch ? { attempt: entry, dispatch, identity } : null
  }
  return null
}

function rejected(reason: string) {
  return { status: 'rejected' as const, code: REPORT_INVALID_CODE, reason }
}

async function readAndValidateSubmission(input: {
  context: PipelineAgentReportContext
  attempt: AttemptEntry
  expectedReportPath: string
}) {
  const read = await readPipelineReport(input.expectedReportPath, {
    ...input.context.target,
    attemptFingerprint: input.attempt.fingerprint
  })
  if (read.status !== 'read') {
    return read
  }
  let raw: unknown
  try {
    raw = JSON.parse(read.bytes.toString('utf8'))
  } catch {
    return { status: 'invalid' as const, reason: 'Agent report is not valid JSON.' }
  }
  const validation = await validatePipelineReport(raw, input.context.node, input.context.fileExists)
  return validation.ok
    ? { status: 'valid' as const }
    : { status: 'invalid' as const, reason: validation.error }
}

/** Rejects Agent worker_done submissions whose exact report or protected files are invalid. */
export function createPipelineSubmissionAdapter(
  deps: PipelineSubmissionPreflightDependencies
): SubmissionAdapter<unknown> {
  return {
    async preflightWorkerReport(submission, context) {
      const origin = activeAgentDispatch(context.ledger, submission.dispatchId, deps.store)
      if (!origin) {
        return ACCEPTED
      }
      const baseline = deps.store.attemptBaseline(
        origin.attempt.watcherId,
        origin.attempt.fingerprint
      )
      if (!baseline) {
        return ACCEPTED
      }
      const { identity } = origin
      let reportContext: PipelineAgentReportContext
      try {
        reportContext = await deps.resolveReportContext({
          enrollment: context.enrollment,
          attempt: origin.attempt,
          dispatch: origin.dispatch,
          baseline
        })
      } catch {
        return ACCEPTED
      }
      if (
        identity.nodeId !== reportContext.node.id ||
        reportContext.target.executionHostId !== context.enrollment.executionHostId ||
        reportContext.target.workspacePath !== baseline.workspacePath ||
        (origin.dispatch.workspaceId !== null &&
          reportContext.target.workspaceId !== origin.dispatch.workspaceId)
      ) {
        return ACCEPTED
      }
      let expectedReportPath: string
      try {
        expectedReportPath = issuePipelineReportPath(
          reportContext.target,
          origin.attempt.fingerprint
        )
      } catch {
        return ACCEPTED
      }
      const reportedPath = submission.payload.reportPath
      if (
        origin.dispatch.reportPath !== expectedReportPath ||
        typeof reportedPath !== 'string' ||
        reportedPath !== expectedReportPath
      ) {
        return rejected('report-path-mismatch')
      }

      const before = parseProtectedDigest(baseline.digest)
      if (!before) {
        return ACCEPTED
      }
      let after
      try {
        after = await (deps.captureDigest ?? captureProtectedDigest)(reportContext.target)
      } catch {
        return ACCEPTED
      }
      const changed = compareProtectedDigest(before, after).changed
      if (changed.length > 0) {
        return rejected(`protected-path-modified:${changed[0]}; Dispatch is still active.`)
      }

      let report
      try {
        report = await readAndValidateSubmission({
          context: reportContext,
          attempt: origin.attempt,
          expectedReportPath
        })
      } catch {
        return ACCEPTED
      }
      if (report.status === 'missing') {
        return rejected('report-missing; Dispatch is still active.')
      }
      if (report.status === 'unverifiable') {
        return report.reason === 'oversize'
          ? rejected('report-exceeds-256-KiB; Dispatch is still active.')
          : ACCEPTED
      }
      if (report.status === 'invalid') {
        return rejected(`${report.reason}; Dispatch is still active.`)
      }
      return ACCEPTED
    }
  }
}
