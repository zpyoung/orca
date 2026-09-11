import {
  LedgerError,
  type LedgerActor,
  type LedgerChange,
  type LedgerEditableSnapshot,
  type LedgerEntry,
  type LedgerEntryType,
  type LedgerMutationContext,
  type LedgerRecord,
  type LedgerRequest,
  type LedgerState
} from '../../shared/ledger'
import { changedFields, cloneLedger } from '../../shared/ledger-entry-snapshots'
import { validateLedgerContent } from '../../shared/ledger-content-validation'

type EntrySnapshot = LedgerEditableSnapshot

const states: readonly LedgerState[] = ['open', 'resolved', 'archived']
const editableFields: Record<LedgerEntryType, readonly string[]> = {
  bug: ['title', 'file', 'description', 'severity'],
  deferred: ['title', 'why_deferred', 'priority'],
  'test-gap': ['title', 'file_under_test', 'reason_skipped'],
  proposal: ['title', 'context', 'recommendation'],
  decision: ['title', 'context', 'decision', 'consequences', 'status']
}

function snapshot(
  content: Record<string, unknown>,
  state: LedgerState,
  reviewed: boolean
): EntrySnapshot {
  return { content: cloneLedger(content), state, reviewed }
}

function historySnapshot(change: LedgerChange): EntrySnapshot {
  const value = change.after
  return value ? cloneLedger(value) : { content: {}, state: 'open', reviewed: false }
}

function conflict(entry: LedgerEntry): never {
  throw new LedgerError('conflict', 'Entry revision is stale', { currentRevision: entry.revision })
}

function recordRevision(record: LedgerRecord): void {
  record.revision += 1
  record.entryCount = record.entries.length
}

function appendChange(
  entry: LedgerEntry,
  actor: LedgerActor,
  at: string,
  before: EntrySnapshot,
  after: EntrySnapshot,
  revision: number
): void {
  entry.history.push({
    revision,
    at,
    actor: cloneLedger(actor),
    before: cloneLedger(before),
    after: cloneLedger(after),
    changedFields: [
      ...changedFields(before.content, after.content),
      ...(before.state === after.state ? [] : ['state']),
      ...(before.reviewed === after.reviewed ? [] : ['reviewed'])
    ]
  })
}

function applyEntryChange(
  entry: LedgerEntry,
  actor: LedgerActor,
  now: string,
  content: Record<string, unknown>,
  state: LedgerState,
  reviewed: boolean,
  contentOrStateChanged: boolean,
  replaceContent: boolean
): boolean {
  const before = snapshot(entry.content, entry.state, entry.reviewed)
  const after = snapshot(content, state, reviewed)
  if (JSON.stringify(before) === JSON.stringify(after)) {
    return false
  }
  entry.content = replaceContent
    ? cloneLedger(content)
    : { ...entry.content, ...cloneLedger(content) }
  entry.state = state
  entry.reviewed = reviewed
  entry.revision += 1
  entry.updatedAt = now
  if (contentOrStateChanged) {
    entry.latestContentActor = cloneLedger(actor)
  }
  appendChange(entry, actor, now, before, after, entry.revision)
  return true
}

export function createLedgerEntry(
  record: LedgerRecord,
  type: LedgerEntryType,
  content: Record<string, unknown>,
  context: LedgerMutationContext,
  now: string
): LedgerEntry {
  // Validation must happen before touching the allocation counter or entry list.
  validateLedgerContent(type, content)
  const sequence = record.nextSequence
  const entryContent = cloneLedger(content)
  const entry: LedgerEntry = {
    id: `${type}-${sequence}`,
    type,
    sequence,
    revision: 1,
    content: entryContent,
    state: 'open',
    reviewed: false,
    origin: cloneLedger(context.origin ?? {}),
    createdAt: now,
    updatedAt: now,
    history: [],
    latestContentActor: cloneLedger(context.actor)
  }
  const initial = snapshot(entry.content, entry.state, entry.reviewed)
  appendChange(
    entry,
    context.actor,
    now,
    { content: {}, state: 'open', reviewed: false },
    initial,
    1
  )
  record.nextSequence += 1
  record.entries.push(entry)
  recordRevision(record)
  return entry
}

export function mutateLedgerEntry(
  record: LedgerRecord,
  request: LedgerRequest,
  context: LedgerMutationContext,
  now: string,
  options?: { replaceContent?: boolean }
): { entry: LedgerEntry; changed: boolean } {
  const entry = record.entries.find((candidate) => candidate.id === request.id)
  if (!entry) {
    throw new LedgerError('not-found', 'Entry not found')
  }
  if (request.ifRevision !== entry.revision) {
    conflict(entry)
  }

  let content = cloneLedger(entry.content)
  let state = entry.state
  let reviewed = entry.reviewed
  let contentOrStateChanged = false

  if (request.operation === 'edit') {
    content = options?.replaceContent
      ? cloneLedger(request.content ?? {})
      : { ...content, ...cloneLedger(request.content ?? {}) }
    validateLedgerContent(entry.type, content)
    contentOrStateChanged = JSON.stringify(content) !== JSON.stringify(entry.content)
  } else if (request.operation === 'state') {
    if (!states.includes(request.state as LedgerState)) {
      throw new LedgerError('invalid-state', 'Invalid lifecycle state')
    }
    state = request.state as LedgerState
    contentOrStateChanged = state !== entry.state
  } else if (request.operation === 'review') {
    if (context.channel !== 'ui') {
      throw new LedgerError('forbidden', 'Review is UI-only')
    }
    reviewed = true
  } else if (request.operation === 'revert') {
    const target = entry.history.find((change) => change.revision === request.toRevision)
    if (!target || !target.after) {
      throw new LedgerError('not-found', 'Revision not found')
    }
    const targetSnapshot = historySnapshot(target)
    for (const field of editableFields[entry.type]) {
      if (Object.prototype.hasOwnProperty.call(targetSnapshot.content, field)) {
        content[field] = cloneLedger(targetSnapshot.content[field])
      } else {
        delete content[field]
      }
    }
    state = targetSnapshot.state
    contentOrStateChanged =
      JSON.stringify(content) !== JSON.stringify(entry.content) || state !== entry.state
  }

  // A review is the only operation whose effective change is review-only.
  if (request.operation !== 'review' && contentOrStateChanged) {
    reviewed = context.channel === 'ui'
  }
  const changed = applyEntryChange(
    entry,
    context.actor,
    now,
    content,
    state,
    reviewed,
    contentOrStateChanged,
    options?.replaceContent === true
  )
  if (!changed) {
    return { entry, changed: false }
  }
  recordRevision(record)
  return { entry, changed: true }
}

export function applyLedgerBulk(
  record: LedgerRecord,
  request: LedgerRequest,
  context: LedgerMutationContext,
  now: string
): { entries: LedgerEntry[]; changed: boolean } {
  if (context.channel !== 'ui') {
    throw new LedgerError('forbidden', 'Bulk mutations are UI-only')
  }
  if (request.operation === 'bulk-state') {
    if (request.confirmed !== true) {
      throw new LedgerError('confirmation-required', 'Bulk state change requires UI confirmation')
    }
    if (!states.includes(request.state as LedgerState)) {
      throw new LedgerError('invalid-state', 'Invalid lifecycle state')
    }
  }
  const selections = request.selections ?? []
  const ids = new Set<string>()
  const selected: LedgerEntry[] = []
  // Complete preflight is deliberately separate from mutation so stale rows cannot partially apply.
  for (const selection of selections) {
    if (ids.has(selection.id)) {
      throw new LedgerError('invalid-request', 'Bulk selections must be unique')
    }
    ids.add(selection.id)
    const entry = record.entries.find((candidate) => candidate.id === selection.id)
    if (!entry) {
      throw new LedgerError('conflict', 'Bulk selection is stale', { id: selection.id })
    }
    if (selection.revision !== entry.revision) {
      conflict(entry)
    }
    selected.push(entry)
  }

  let changed = false
  for (const entry of selected) {
    const before = snapshot(entry.content, entry.state, entry.reviewed)
    const state = request.operation === 'approve' ? entry.state : (request.state as LedgerState)
    // A same-state bulk selection must not become an implicit approval.
    const effectiveState = state !== entry.state
    const reviewed = request.operation === 'approve' ? true : effectiveState
    const effective = effectiveState || (request.operation === 'approve' && !entry.reviewed)
    if (!effective) {
      continue
    }
    const after = snapshot(entry.content, state, reviewed)
    entry.state = state
    entry.reviewed = reviewed
    entry.revision += 1
    entry.updatedAt = now
    if (effectiveState) {
      entry.latestContentActor = cloneLedger(context.actor)
    }
    appendChange(entry, context.actor, now, before, after, entry.revision)
    changed = true
  }
  if (changed) {
    recordRevision(record)
  }
  return { entries: selected, changed }
}
