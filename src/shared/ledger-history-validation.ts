import type { LedgerEntry, LedgerEntryType, LedgerState } from './ledger'
import { validateLedgerContent } from './ledger-content-validation'
import {
  DECISION_STATUSES,
  isObject,
  isoDate,
  LEDGER_TYPES,
  positiveInt,
  PRIORITIES,
  SEVERITIES,
  STATES,
  validActor,
  validOwner
} from './ledger-validation-primitives'

function validSnapshot(snapshot: unknown): boolean {
  if (snapshot === null) {
    return true
  }
  if (
    !isObject(snapshot) ||
    !isObject(snapshot.content) ||
    !STATES.includes(snapshot.state as LedgerState) ||
    typeof snapshot.reviewed !== 'boolean'
  ) {
    return false
  }
  const content = snapshot.content
  return (
    (content.severity === undefined || SEVERITIES.includes(content.severity as never)) &&
    (content.priority === undefined || PRIORITIES.includes(content.priority as never)) &&
    (content.status === undefined || DECISION_STATUSES.includes(content.status as never))
  )
}

export function validLedgerEntry(value: unknown): value is LedgerEntry {
  if (!isObject(value)) {
    return false
  }
  const revision = value.revision
  if (
    typeof value.id !== 'string' ||
    !LEDGER_TYPES.includes(value.type as LedgerEntryType) ||
    !positiveInt(value.sequence) ||
    !positiveInt(revision) ||
    !isObject(value.content) ||
    !STATES.includes(value.state as LedgerState) ||
    typeof value.reviewed !== 'boolean' ||
    !isObject(value.origin) ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string' ||
    !isoDate(value.createdAt) ||
    !isoDate(value.updatedAt) ||
    !Array.isArray(value.history) ||
    !validActor(value.latestContentActor)
  ) {
    return false
  }
  const type = value.type as LedgerEntryType
  if (!new RegExp(`^${type}-\\d+$`).test(value.id) || !value.id.endsWith(`-${value.sequence}`)) {
    return false
  }
  if (
    (value.origin.workspaceId !== undefined && typeof value.origin.workspaceId !== 'string') ||
    (value.origin.branch !== undefined && typeof value.origin.branch !== 'string') ||
    (value.origin.host !== undefined && typeof value.origin.host !== 'string') ||
    (value.origin.revision !== undefined && typeof value.origin.revision !== 'string') ||
    (value.origin.observedAt !== undefined && !isoDate(value.origin.observedAt)) ||
    (value.origin.owner !== undefined && !validOwner(value.origin.owner))
  ) {
    return false
  }
  try {
    validateLedgerContent(type, value.content)
  } catch {
    return false
  }
  const revisions = new Set<number>()
  let previous = 0
  const historyValid = value.history.every((change) => {
    if (
      !isObject(change) ||
      !positiveInt(change.revision) ||
      change.revision > revision ||
      revisions.has(change.revision) ||
      change.revision !== previous + 1 ||
      !isoDate(change.at) ||
      !validActor(change.actor) ||
      !Array.isArray(change.changedFields) ||
      !validSnapshot(change.before) ||
      !validSnapshot(change.after)
    ) {
      return false
    }
    revisions.add(change.revision)
    previous = change.revision
    return true
  })
  return historyValid && previous === revision
}
