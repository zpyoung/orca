export type HostedReviewSitterProvider = 'github' | 'gitlab'

export type HostedReviewSitterCapability =
  | 'updateBranch'
  | 'resolveConflicts'
  | 'fixChecks'
  | 'merge'

export type HostedReviewSitterCapabilityMode = 'off' | 'gated' | 'on'

export type HostedReviewSitterCapabilities = Record<
  HostedReviewSitterCapability,
  HostedReviewSitterCapabilityMode
>

export type HostedReviewMergeMethod = 'merge' | 'squash' | 'rebase'
export type HostedReviewBranchUpdateMode = 'merge-base-update' | 'rebase'

export type HostedReviewSitterDefinition = {
  id: string
  enabled: boolean
  repoId: string
  worktreeId: string
  repoPath: string
  branch: string
  provider: HostedReviewSitterProvider
  reviewNumber: number
  reviewUrl: string
  capabilities: HostedReviewSitterCapabilities
  activeBudgetMs: number
  branchUpdateMode: HostedReviewBranchUpdateMode
  /** `null` follows the provider snapshot's repository default. */
  mergeMethod: HostedReviewMergeMethod | null
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

export type HostedReviewSnapshot = {
  provider: HostedReviewSitterProvider
  reviewNumber: number
  url: string
  lifecycle: HostedReviewLifecycle
  headSha: string
  baseSha: string
  observedAtMs: number
  /** Merge/enqueue gates require `live`; cached snapshots may drive every other action. */
  freshness: 'live' | 'cached'
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

export type HostedReviewSitterActionKind =
  | 'rerun-check'
  | 'prepare-fix'
  | 'publish-fix'
  | 'prepare-conflict-resolution'
  | 'publish-conflict-resolution'
  | 'update-branch'
  | 'merge'
  | 'enqueue'

type HostedReviewSitterActionBase = {
  kind: HostedReviewSitterActionKind
  /** Idempotency identity: current provider head plus the complete action target. */
  key: string
  /** Exact evidence identity used by gated approvals. */
  evidenceKey: string
  headSha: string
  capability: HostedReviewSitterCapability
}

export type RerunCheckAction = {
  kind: 'rerun-check'
  capability: 'fixChecks'
  checkKey: string
  checkIds: readonly string[]
  observationIds: readonly string[]
  failureSignature: string | null
} & HostedReviewSitterActionBase

export type PrepareFixAction = {
  kind: 'prepare-fix'
  capability: 'fixChecks'
  checkKey: string
  checkIds: readonly string[]
  observationIds: readonly string[]
  failureSignature: string
  evidence: 'fresh-rerun' | 'same-shard-multi-node'
} & HostedReviewSitterActionBase

export type PublishFixAction = {
  kind: 'publish-fix'
  capability: 'fixChecks'
  checkKey: string
  failureSignature: string
  preparationActionId: string
  preparedCommitSha: string
} & HostedReviewSitterActionBase

export type PrepareConflictResolutionAction = {
  kind: 'prepare-conflict-resolution'
  capability: 'resolveConflicts'
  baseSha: string
} & HostedReviewSitterActionBase

export type PublishConflictResolutionAction = {
  kind: 'publish-conflict-resolution'
  capability: 'resolveConflicts'
  baseSha: string
  preparationActionId: string
  preparedCommitSha: string
} & HostedReviewSitterActionBase

export type UpdateBranchAction = {
  kind: 'update-branch'
  capability: 'updateBranch'
  baseSha: string
  mode: HostedReviewBranchUpdateMode
} & HostedReviewSitterActionBase

export type MergeAction = {
  kind: 'merge'
  capability: 'merge'
  mergeMethod: HostedReviewMergeMethod
} & HostedReviewSitterActionBase

export type EnqueueAction = {
  kind: 'enqueue'
  capability: 'merge'
} & HostedReviewSitterActionBase

export type HostedReviewSitterAction =
  | RerunCheckAction
  | PrepareFixAction
  | PublishFixAction
  | PrepareConflictResolutionAction
  | PublishConflictResolutionAction
  | UpdateBranchAction
  | MergeAction
  | EnqueueAction

export type HostedReviewSitterActionState = 'attempted' | 'running' | 'completed' | 'failed'
export type HostedReviewSitterActionEffect = 'none' | 'committed' | 'unknown'

export type PreparedActionResult = {
  kind: 'prepared'
  preparedCommitSha: string
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
  | PreparedActionResult
  | PublishedActionResult
  | RerunActionResult
  | EmptyActionResult

export type ActionLedgerEntry = {
  kind: 'action'
  eventId: string
  actionId: string
  atMs: number
  action: HostedReviewSitterAction
  state: HostedReviewSitterActionState
  /** Required for failed actions; omitted for nonterminal transitions. */
  effect?: HostedReviewSitterActionEffect
  result?: HostedReviewSitterActionResult
  reason?: string
}

export type ActionApprovalScope = {
  action: HostedReviewSitterActionKind
  headSha: string
  evidenceKey: string
  /** Publication approval is invalid without the exact prepared commit. */
  preparedCommitSha?: string
}

export type ApprovalLedgerEntry = {
  kind: 'approval'
  eventId: string
  atMs: number
  scope: ActionApprovalScope
  decision: 'approved' | 'rejected'
}

export type HostedReviewSitterDiscrepancyKind =
  | 'check-failure'
  | 'merge-conflict'
  | 'queue-ejected'
  | 'fix-did-not-resolve'
  | 'ambiguous-action'
  | 'unverifiable-failure'
  | 'awaiting-approval'

export type HostedReviewSitterDiscrepancyStatus = 'open' | 'acknowledged' | 'resolved' | 'escalated'

export type DiscrepancyLedgerEntry = {
  kind: 'discrepancy'
  eventId: string
  atMs: number
  discrepancyId: string
  discrepancyKind: HostedReviewSitterDiscrepancyKind
  evidenceKey: string
  headSha: string
  status: HostedReviewSitterDiscrepancyStatus
  /** An acknowledgement only authorizes this exact action evidence. */
  approvalScope?: ActionApprovalScope
  reason?: string
}

export type FixAttributionLedgerEntry = {
  kind: 'fix-attribution'
  eventId: string
  atMs: number
  sourceHeadSha: string
  producedHeadSha: string
  preparedCommitSha: string
  checkKey: string
  failureSignature: string
  publishActionId: string
}

export type ActiveTimeLedgerEntry = {
  kind: 'active-time'
  eventId: string
  atMs: number
  /**
   * A completed, service-observed running interval. The service checkpoints
   * while alive; the pure core never extends a checkpoint across a restart.
   */
  activeMs: number
  source: 'tick' | 'pause' | 'shutdown'
}

export type LifecycleLedgerEntry = {
  kind: 'lifecycle'
  eventId: string
  atMs: number
  state: 'merged' | 'closed'
  headSha: string
}

export type HostedReviewSitterLedgerEntry =
  | ActionLedgerEntry
  | ApprovalLedgerEntry
  | DiscrepancyLedgerEntry
  | FixAttributionLedgerEntry
  | ActiveTimeLedgerEntry
  | LifecycleLedgerEntry

export type HostedReviewSitterLedger = {
  sitterId: string
  entries: readonly HostedReviewSitterLedgerEntry[]
}

export type HostedReviewSitterContention =
  | { state: 'clear' }
  | { state: 'dirty'; reason?: string }
  | { state: 'foreign-agent'; sessionId: string }
  | { state: 'sitter-fix-agent'; actionId: string }
  | { state: 'unverifiable'; reason?: string }
  | { state: 'abandoned-sitter-fix'; actionId: string; reason?: string }

export type HostedReviewSitterGateDecision =
  | { verdict: 'allow' }
  | { verdict: 'hold'; reason: string }
  | { verdict: 'escalate'; reason: string }

export type DerivedHostedReviewSitterDiscrepancy = {
  id: string
  kind: HostedReviewSitterDiscrepancyKind
  evidenceKey: string
  headSha: string
  status: HostedReviewSitterDiscrepancyStatus
  approvalScope?: ActionApprovalScope
  reason: string
}

export type HostedReviewSitterStatusState =
  | 'watching'
  | 'held'
  | 'acting'
  | 'escalated'
  | 'budget-exhausted'
  | 'merged'
  | 'closed'
  | 'disabled'

export type HostedReviewSitterStatus = {
  sitterId: string
  enabled: boolean
  state: HostedReviewSitterStatusState
  reason: string | null
  activeTimeMs: number
  remainingBudgetMs: number
  desiredAction: HostedReviewSitterAction | null
  discrepancies: readonly DerivedHostedReviewSitterDiscrepancy[]
}
