import type { ApprovalScope, AttemptEntry, KernelAction } from '../fork-heimdall/ledger-types'
import type { Snapshot } from '../fork-heimdall/snapshot'
import type { CapabilityMode } from '../fork-heimdall/watcher-types'

export type HostedReviewSitterProvider = 'github' | 'gitlab'

export type HostedReviewSitterCapability =
  | 'updateBranch'
  | 'resolveConflicts'
  | 'fixChecks'
  | 'merge'

export type HostedReviewSitterCapabilities = Record<HostedReviewSitterCapability, CapabilityMode>

export type HostedReviewMergeMethod = 'merge' | 'squash' | 'rebase'
export type HostedReviewMergeCheckScope = 'required' | 'all'

export type HostedReviewBranchUpdateMode = 'merge-base-update' | 'rebase'

/** Kind-owned payload persisted inside a kernel enrollment. Authority replaces the review identity. */
export type HostedReviewEnrollmentPayload = {
  branch: string
  provider: HostedReviewSitterProvider
  reviewNumber: number
  reviewUrl: string
  branchUpdateMode: HostedReviewBranchUpdateMode
  /** `null` follows the provider snapshot's repository default. */
  mergeMethod: HostedReviewMergeMethod | null
  mergeCheckScope: HostedReviewMergeCheckScope
}

/** Authorized view supplied to providers and the pure decision core. */
export type HostedReviewSitterDefinition = HostedReviewEnrollmentPayload & {
  repoId: string
  worktreeId: string
  repoPath: string
  capabilities: HostedReviewSitterCapabilities
}

export type HostedReviewLifecycle = 'open' | 'merged' | 'closed'
export type HostedReviewCheckState =
  | 'pending'
  | 'passed'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'unknown'

export type HostedReviewCheckSnapshot = {
  /** Provider-neutral logical check name, stable across attempts and matrix nodes. */
  checkKey: string
  /** Provider check/job identifier. */
  checkId: string
  name: string
  required: boolean
  headSha: string
  state: HostedReviewCheckState
  /** Distinguishes rerun attempts even when the provider reuses a check ID. */
  observationId: string
  /** Stable classification of the failing log, or null when it cannot be established. */
  failureSignature: string | null
  /** Matrix shard identity, excluding the runtime/node dimension. */
  shardKey?: string
  /** Runtime/node dimension used to prove a same-shard multi-node failure. */
  runtimeKey?: string
}

export type HostedReviewReadinessBlocker =
  | 'approvals'
  | 'checks'
  | 'behind'
  | 'conflicts'
  | 'draft'
  | 'discussions'
  | 'policy'
  | 'unknown'

export type HostedReviewProviderReadiness = {
  /** The provider's composite merge verdict, not a locally inferred approval verdict. */
  verdict: 'ready' | 'blocked' | 'unknown'
  /** Complete when verdict is blocked; unknown/incomplete evidence must use `unknown`. */
  blockers: readonly HostedReviewReadinessBlocker[]
}

export type HostedReviewQueueSnapshot = {
  required: boolean
  membership: 'not-enqueued' | 'enqueued' | 'ejected' | 'unknown'
}

/** Kind-owned review world. Freshness, content identity and observation time live on Snapshot. */
export type HostedReviewSnapshot = {
  provider: HostedReviewSitterProvider
  reviewNumber: number
  url: string
  lifecycle: HostedReviewLifecycle
  headSha: string
  baseSha: string
  draft: boolean
  checks: readonly HostedReviewCheckSnapshot[]
  /** False when required contexts, pagination, or check detail could not be verified. */
  checksComplete: boolean
  providerReadiness: HostedReviewProviderReadiness
  behindBase: boolean
  conflicts: 'none' | 'present' | 'unknown'
  queue: HostedReviewQueueSnapshot
  defaultMergeMethod: HostedReviewMergeMethod
}

export type HostedReviewPreparedCommit = {
  sourceHeadSha: string
  preparedCommitSha: string
  preparationAttemptFingerprint: string
}

export type HostedReviewWorld = {
  review: HostedReviewSnapshot
  definition: HostedReviewSitterDefinition
  preparedCommit: HostedReviewPreparedCommit | null
}

export type HostedReviewWorldSnapshot = Snapshot<HostedReviewWorld>

export type HostedReviewSitterActionKind =
  | 'rerun-check'
  | 'prepare-fix'
  | 'publish-fix'
  | 'prepare-conflict-resolution'
  | 'publish-conflict-resolution'
  | 'update-branch'
  | 'merge'
  | 'enqueue'

type HostedReviewActionBase = KernelAction & {
  kind: HostedReviewSitterActionKind
  capability: HostedReviewSitterCapability
  contentIdentity: string
  evidenceKey: string
  headSha: string
  reviewUrl: string
}

type HostedReviewExternalActionBase = HostedReviewActionBase & {
  visibility: 'external'
  expectedState: { target: string; before: string }
}

type HostedReviewLocalActionBase = HostedReviewActionBase & {
  visibility: 'local'
  expectedState?: never
}

export type RerunCheckAction = HostedReviewExternalActionBase & {
  kind: 'rerun-check'
  capability: 'fixChecks'
  checkKey: string
  checkIds: readonly string[]
  observationIds: readonly string[]
  failureSignature: string | null
}

export type PrepareFixAction = HostedReviewLocalActionBase & {
  kind: 'prepare-fix'
  capability: 'fixChecks'
  checkKey: string
  checkIds: readonly string[]
  observationIds: readonly string[]
  failureSignature: string
  evidence: 'fresh-rerun' | 'same-shard-multi-node'
}

export type PublishFixAction = HostedReviewExternalActionBase & {
  kind: 'publish-fix'
  capability: 'fixChecks'
  checkKey: string
  failureSignature: string
  preparationActionId: string
  preparedCommitSha: string
}

export type PrepareConflictResolutionAction = HostedReviewLocalActionBase & {
  kind: 'prepare-conflict-resolution'
  capability: 'resolveConflicts'
  baseSha: string
}

export type PublishConflictResolutionAction = HostedReviewExternalActionBase & {
  kind: 'publish-conflict-resolution'
  capability: 'resolveConflicts'
  baseSha: string
  preparationActionId: string
  preparedCommitSha: string
}

export type UpdateBranchAction = HostedReviewExternalActionBase & {
  kind: 'update-branch'
  capability: 'updateBranch'
  baseSha: string
  mode: HostedReviewBranchUpdateMode
}

export type MergeAction = HostedReviewExternalActionBase & {
  kind: 'merge'
  capability: 'merge'
  mergeMethod: HostedReviewMergeMethod
  checkScope: HostedReviewMergeCheckScope
}

export type EnqueueAction = HostedReviewExternalActionBase & {
  kind: 'enqueue'
  checkScope: HostedReviewMergeCheckScope
  capability: 'merge'
}

export type HostedReviewSitterAction =
  | RerunCheckAction
  | PrepareFixAction
  | PublishFixAction
  | PrepareConflictResolutionAction
  | PublishConflictResolutionAction
  | UpdateBranchAction
  | MergeAction
  | EnqueueAction

export type WorkerDispatchedActionResult = {
  kind: 'worker-dispatched'
  dispatchId: string
}

export type PublishedActionResult = {
  kind: 'published'
  resultingHeadSha: string
}

export type RerunActionResult = {
  kind: 'rerun-requested'
}

export type EmptyActionResult = {
  kind: 'none'
}

export type HostedReviewSitterActionResult =
  | WorkerDispatchedActionResult
  | PublishedActionResult
  | RerunActionResult
  | EmptyActionResult

export type HostedReviewAttemptEntry = Omit<AttemptEntry, 'action' | 'result'> & {
  action: HostedReviewSitterAction
  result?: HostedReviewSitterActionResult
}

export type HostedReviewFixAttribution = {
  sourceHeadSha: string
  producedHeadSha: string
  preparedCommitSha: string
  checkKey: string
  failureSignature: string
  publishActionId: string
}

export type HostedReviewSitterContention =
  | { state: 'clear' }
  | { state: 'dirty'; reason?: string }
  | { state: 'foreign-agent'; sessionId: string }
  | { state: 'sitter-fix-agent'; actionId: string }
  | { state: 'unverifiable'; reason?: string }
  | { state: 'abandoned-sitter-fix'; actionId: string; reason?: string }

export type HostedReviewSitterDiscrepancyKind =
  | 'check-failure'
  | 'merge-conflict'
  | 'queue-ejected'
  | 'fix-did-not-resolve'
  | 'unresolved-action'
  | 'unverifiable-failure'
  | 'awaiting-approval'

export type HostedReviewSitterDiscrepancyStatus = 'open' | 'acknowledged' | 'resolved' | 'escalated'

export type DerivedHostedReviewSitterDiscrepancy = {
  id: string
  kind: HostedReviewSitterDiscrepancyKind
  evidenceKey: string
  headSha: string
  status: HostedReviewSitterDiscrepancyStatus
  approvalScope?: ApprovalScope
  reason: string
}
