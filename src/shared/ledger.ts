export type LedgerEntryType = 'bug' | 'deferred' | 'test-gap' | 'proposal' | 'decision'
export type LedgerState = 'open' | 'resolved' | 'archived'
export type LedgerDecisionStatus = 'proposed' | 'accepted' | 'superseded'
export type LedgerSeverity = 'critical' | 'high' | 'medium' | 'low'
export type LedgerPriority = 'high' | 'medium' | 'low'
export type LedgerActorKind = 'human' | 'agent' | 'import' | 'unknown'
export type LedgerChannel = 'cli' | 'ui'

export type LedgerRuntimeIdentity = { runtimeId: string; profileId: string }
export type LedgerOwner = { tier: 'project' | 'group'; id: string }
export type LedgerLocationBase = { kind: 'project' | 'workspace'; id: string; host?: string }
export type LedgerLocation = {
  path: string
  line?: number
  base: LedgerLocationBase
  external?: boolean
  host?: string
}
export type LedgerActor = {
  kind: LedgerActorKind
  tool?: string
  model: string | null
  providerSessionId: string | null
  sourceAnchor?: string
  initiator?: LedgerActor
}
export type LedgerOrigin = {
  workspaceId?: string
  owner?: LedgerOwner
  branch?: string
  host?: string
  revision?: string
  observedAt?: string
}
export type LedgerEditableSnapshot = {
  content: Record<string, unknown>
  state: LedgerState
  reviewed: boolean
}
export type LedgerChange = {
  revision: number
  at: string
  actor: LedgerActor
  before: LedgerEditableSnapshot | null
  after: LedgerEditableSnapshot | null
  changedFields: string[]
}
export type LedgerMetadataChange = Omit<LedgerChange, 'before' | 'after'> & {
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}
export type LedgerEntry = {
  id: string
  type: LedgerEntryType
  sequence: number
  revision: number
  content: Record<string, unknown>
  state: LedgerState
  reviewed: boolean
  origin: LedgerOrigin
  createdAt: string
  updatedAt: string
  history: LedgerChange[]
  latestContentActor: LedgerActor
  [key: string]: unknown
}
export type LedgerSummary = {
  ledgerId: string
  tier: LedgerOwner['tier']
  revision: number
  owner: LedgerOwner | null
  formerOwner: LedgerOwner | null
  runtime: LedgerRuntimeIdentity
  entryCount: number
  nextSequence: number
  staleAfterDays: number
  sourceEquivalences: string[][]
  [key: string]: unknown
}
export type LedgerRecord = LedgerSummary & {
  version?: 1
  entries: LedgerEntry[]
  importAnchors: Record<string, LedgerImportAnchor>
  metadataHistory: LedgerMetadataChange[]
}
export type LedgerTarget = {
  workspaceId?: string
  owner?: LedgerOwner
  ledgerId?: string
  group?: boolean
  groupSelector?: string
}
export type LedgerFilters = {
  type?: LedgerEntryType
  state?: LedgerState
  reviewed?: boolean
  stale?: boolean
  workspaceId?: string
  branch?: string
}
export type LedgerReviewCandidate = {
  entry: LedgerEntry
  stale: boolean
  reason: string
  evidence?: LedgerEvidence
}
export type LedgerEvidence = {
  available: boolean
  workspaceId?: string
  observedRevision?: string
  observedAt?: string
  baselineRevision?: string
  fileExists?: boolean
  note?: string
}
export type LedgerImportRecord = {
  anchor: string
  type: LedgerEntryType
  content: Record<string, unknown>
  sourcePath?: string
  sourceBase?: LedgerLocationBase
  legacyId?: string
}
export type LedgerImportSkip = { anchor?: string; reason: string; sourcePath?: string }
export type LedgerImportAnchor = {
  entryId?: string
  baseline?: Record<string, unknown>
  deleted?: boolean
  sourcePath?: string
  sourceBase?: LedgerLocationBase
  legacyId?: string
}
export type LedgerImportResult = {
  created: string[]
  updated: string[]
  alreadyPresent: string[]
  skipped: LedgerImportSkip[]
}
export type LedgerRemovalPreview = {
  ledgerId: string
  owner: LedgerOwner
  revision: number
  entryCount: number
}
export type LedgerRequest = {
  operation:
    | 'file'
    | 'list'
    | 'show'
    | 'edit'
    | 'state'
    | 'review'
    | 'revert'
    | 'import'
    | 'catalog'
    | 'approve'
    | 'bulk-state'
    | 'delete-entries'
    | 'delete-ledger'
    | 'attach'
    | 'settings'
    | 'removal-preview'
  target?: LedgerTarget
  type?: LedgerEntryType
  content?: Record<string, unknown>
  id?: string
  ifRevision?: number
  toRevision?: number
  state?: LedgerState
  filters?: LedgerFilters
  selections?: { id: string; revision: number }[]
  ifLedgerRevision?: number
  attachTo?: LedgerOwner
  confirmed?: boolean
  staleAfterDays?: number
  removal?: {
    repoId?: string
    projectGroupId?: string
    repoIds?: string[]
    removeContainedProjects?: boolean
    expectedLedgers?: { ledgerId: string; revision: number }[]
  }
}
export type LedgerResponse = {
  schemaVersion: 1
  runtime: LedgerRuntimeIdentity
  ledger: LedgerSummary | null
  entry?: LedgerEntry
  entries?: LedgerEntry[]
  ledgers?: LedgerSummary[]
  matches?: LedgerEntry[]
  candidates?: LedgerReviewCandidate[]
  importResult?: LedgerImportResult
  removalPreview?: LedgerRemovalPreview[]
}
export class LedgerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'LedgerError'
  }
}
export type LedgerMutationContext = {
  channel: LedgerChannel
  actor: LedgerActor
  origin?: LedgerOrigin
  owner?: LedgerOwner
  ledgerId?: string
  importRecords?: LedgerImportRecord[]
  importSkipped?: LedgerImportSkip[]
  ownerIsLive?: (owner: LedgerOwner) => boolean
}
