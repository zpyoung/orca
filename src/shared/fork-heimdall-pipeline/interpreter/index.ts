import type { CapabilityMode } from '../../fork-heimdall/watcher-types'
import type { DecisionOutcome, KernelAction } from '../../fork-heimdall/kind-contract'
import type { FiredStopPredicate } from '../../fork-heimdall/stop-policy'
import type { Snapshot } from '../../fork-heimdall/snapshot'
import type { PipelineEnrollmentPayload } from '../enrollment-payload'
import type { PipelineStoreFacts } from '../store-facts'
import type { PipelineLandingFacts } from './action-envelope'

export type PipelineMergeSourceFacts = {
  childInstanceId: string
  workspacePath: string | null
  sourceHead: string
  committedChildSha: string | null
  workspaceDigest: string
  applicableBaseCommit: string
  unmergedPaths: string[]
}

export type PipelineComposite = {
  snapshot: Snapshot<unknown>
  phase: string
  decide(): DecisionOutcome<KernelAction>
  evaluateStops(): FiredStopPredicate | null
}

export type PipelineWorld = {
  watcherId: string
  payload: PipelineEnrollmentPayload
  facts: PipelineStoreFacts
  mergeSources?: Readonly<Record<string, PipelineMergeSourceFacts>>
  nowMs: number
  hasOwner: boolean
  grants: Readonly<Record<string, CapabilityMode>>
  workspacePath: string
  landingFacts?: PipelineLandingFacts
  unverifiableDispatchIds: ReadonlySet<string>
  composites: Readonly<Record<string, PipelineComposite>>
  compositeReadErrors?: Readonly<Record<string, string>>
}

export type PipelineNodeRunStatus =
  | 'pending'
  | 'ready'
  | 'running'
  | 'waiting'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'unverifiable'

export type PipelineNodeRunState = {
  status: PipelineNodeRunStatus
  epoch: number
  attempt: number
  round?: number
  waitingFor?: 'gate' | 'choice' | 'capability-approval' | 'owner'
  outputs?: Record<string, unknown>
  failure?: { reason: string; summary?: string }
  warnings?: PipelineStoreFacts['swarmExpansions'][number]['warnings']
  phase?: string
  progress?: { done: number; total: number }
  revision?: number
}

export type PipelineRunState = {
  nodes: Map<string, PipelineNodeRunState>
  terminal: null | 'complete' | 'aborted'
  deadlines: { instanceId: string; atMs: number }[]
}

export type PipelineBuiltInKind = 'objective' | 'hosted-review'

export { decidePipelineNodeDeviation, decidePipelineTick } from './decide'
export { pipelineStopVerdict } from './stop-verdict'
export { derivePipelineRunState, builtinOneNodeRunState } from './run-state'
export { buildPipelineAction, landActionExpectedState } from './action-envelope'
export { mergeOrder } from './merge-order'
export { wrapCompositeAction, unwrapCompositeAction, scopeLedgerForNode } from './ledger-lens'
export { nodeInstanceId, nodeIdFromInstanceId, childTaskIdFromInstanceId } from './node-instance'

export type { PipelineChoice } from '../choice-types'
export type { PipelineLandActionFacts, PipelineLandingFacts } from './action-envelope'
export type { PipelinePin } from '../pipeline-pin'
export type { WatcherLedger } from '../../fork-heimdall/ledger-types'
