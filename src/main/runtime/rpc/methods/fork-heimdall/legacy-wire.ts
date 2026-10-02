import { z } from 'zod'
import { ApprovalScopeSchema } from '../../../../../shared/fork-heimdall/ledger-types'
import {
  EnrollInputSchema,
  type EnrollInput,
  type EnrollResult,
  type WatcherEnrollment,
  type WatcherListEntry
} from '../../../../../shared/fork-heimdall/watcher-types'
import type { HeimdallDebugReport } from '../../../../fork-heimdall/debug-report'
import { defineMethod } from '../../core'
import { requireHeimdallKernel } from './kernel-binding'
import { projectHeimdallLedgerForClient } from './dispatch-result-wire'
import { projectWatcherListEntryForClient } from './park-reason-wire'
import { projectPipelineListForClient } from './pipeline-kind-wire'

export const LEGACY_HEIMDALL_CHANNELS = {
  list: 'heimdall:list',
  enroll: 'heimdall:enroll',
  disarm: 'heimdall:disarm',
  disarmAll: 'heimdall:disarmAll',
  approve: 'heimdall:approve',
  ledger: 'heimdall:ledger',
  debugReport: 'heimdall:debugReport'
} as const

export const LegacyWatcherIdRequestSchema = z.object({ watcherId: z.string().min(1) }).strict()
export const LegacyApproveRequestSchema = z
  .object({ watcherId: z.string().min(1), scope: ApprovalScopeSchema })
  .strict()
export { EnrollInputSchema as LegacyHeimdallEnrollRequestSchema }
export type LegacyHeimdallEnrollRequest = EnrollInput

type LegacyWatcherEnrollment = Omit<WatcherEnrollment, 'paused' | 'commandRevision'>
type LegacyWatcherListEntry = Omit<WatcherListEntry, 'enrollment'> & {
  enrollment: LegacyWatcherEnrollment
}
type LegacyHeimdallDebugReport = Omit<HeimdallDebugReport, 'enrollment'> & {
  enrollment: LegacyWatcherEnrollment
}

export function projectLegacyEnrollResult(result: EnrollResult):
  | EnrollResult
  | {
      status: 'enrolled' | 're-armed'
      entry: LegacyWatcherListEntry
    } {
  return result.status === 'enrolled' || result.status === 're-armed'
    ? { ...result, entry: projectLegacyListEntry(result.entry) }
    : result
}

export function projectLegacyListEntry(entry: WatcherListEntry): LegacyWatcherListEntry {
  const { paused: _paused, commandRevision: _commandRevision, ...enrollment } = entry.enrollment
  return { ...entry, enrollment }
}

export function projectLegacyDebugReport(report: HeimdallDebugReport): LegacyHeimdallDebugReport {
  const { paused: _paused, commandRevision: _commandRevision, ...enrollment } = report.enrollment
  return { ...report, enrollment }
}

export class LegacyHeimdallFencingRequiredError extends Error {
  readonly code = 'owner-conflict'
  readonly reason = 'fencing-required'

  constructor() {
    super(
      'owner-conflict: fencing-required: use heimdall:command with the observed target and owner fence.'
    )
    this.name = 'LegacyHeimdallFencingRequiredError'
  }
}

function refuseUnfencedLegacyMutation(): never {
  throw new LegacyHeimdallFencingRequiredError()
}

export const LEGACY_HEIMDALL_METHODS = [
  defineMethod({
    name: LEGACY_HEIMDALL_CHANNELS.list,
    params: z.object({}).strict(),
    handler: async (_params, context) =>
      projectPipelineListForClient(
        await requireHeimdallKernel(context.runtime).list(),
        context
      ).map((entry) => projectLegacyListEntry(projectWatcherListEntryForClient(entry, context)))
  }),
  defineMethod({
    name: LEGACY_HEIMDALL_CHANNELS.disarm,
    params: LegacyWatcherIdRequestSchema,
    handler: refuseUnfencedLegacyMutation
  }),
  defineMethod({
    name: LEGACY_HEIMDALL_CHANNELS.disarmAll,
    params: z.object({}).strict(),
    handler: refuseUnfencedLegacyMutation
  }),
  defineMethod({
    name: LEGACY_HEIMDALL_CHANNELS.approve,
    params: LegacyApproveRequestSchema,
    handler: refuseUnfencedLegacyMutation
  }),
  defineMethod({
    name: LEGACY_HEIMDALL_CHANNELS.ledger,
    params: LegacyWatcherIdRequestSchema,
    handler: ({ watcherId }, context) =>
      projectHeimdallLedgerForClient(
        requireHeimdallKernel(context.runtime).ledger(watcherId),
        context
      )
  })
]
