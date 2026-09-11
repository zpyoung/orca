import type { LedgerEntry, LedgerRecord } from './ledger'
import { validLedgerEntry } from './ledger-history-validation'
import {
  invalidValidation,
  isObject,
  isoDate,
  positiveInt,
  validActor,
  validOwner
} from './ledger-validation-primitives'

export function validateLedgerStoreRecord(value: unknown): LedgerRecord {
  if (
    !isObject(value) ||
    value.version !== 1 ||
    typeof value.ledgerId !== 'string' ||
    !isObject(value.runtime) ||
    typeof value.runtime.runtimeId !== 'string' ||
    typeof value.runtime.profileId !== 'string' ||
    !['project', 'group'].includes(value.tier as string) ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.entries) ||
    !Number.isSafeInteger(value.nextSequence) ||
    (value.nextSequence as number) < 1 ||
    !Number.isSafeInteger(value.entryCount) ||
    (value.entryCount as number) < 0 ||
    !Number.isSafeInteger(value.staleAfterDays) ||
    (value.staleAfterDays as number) < 0 ||
    !Array.isArray(value.sourceEquivalences) ||
    !isObject(value.importAnchors) ||
    !Array.isArray(value.metadataHistory) ||
    value.entryCount !== value.entries.length ||
    !value.entries.every(validLedgerEntry)
  ) {
    invalidValidation('incompatible-store', 'Ledger store is malformed or unsupported')
  }
  const nextSequence = value.nextSequence
  if (!positiveInt(nextSequence)) {
    invalidValidation('incompatible-store', 'Ledger sequence is invalid')
  }
  const ids = new Set<string>(),
    sequences = new Set<number>()
  for (const entry of value.entries as LedgerEntry[]) {
    if (
      ids.has(entry.id) ||
      sequences.has(entry.sequence) ||
      entry.sequence >= nextSequence ||
      !entry.history.some((change) => change.revision === 1)
    ) {
      invalidValidation('incompatible-store', 'Ledger entry identity or sequence is invalid')
    }
    ids.add(entry.id)
    sequences.add(entry.sequence)
  }
  for (const group of value.sourceEquivalences as unknown[]) {
    if (
      !Array.isArray(group) ||
      group.length < 2 ||
      group.some((id) => typeof id !== 'string' || !id)
    ) {
      invalidValidation('incompatible-store', 'Invalid source equivalence')
    }
  }
  for (const anchor of Object.values(value.importAnchors)) {
    if (
      !isObject(anchor) ||
      (anchor.deleted === true
        ? anchor.baseline !== undefined
        : !isObject(anchor.baseline) ||
          typeof anchor.entryId !== 'string' ||
          !ids.has(anchor.entryId)) ||
      (anchor.entryId !== undefined && typeof anchor.entryId !== 'string') ||
      (anchor.sourcePath !== undefined && typeof anchor.sourcePath !== 'string') ||
      (anchor.legacyId !== undefined && typeof anchor.legacyId !== 'string')
    ) {
      invalidValidation('incompatible-store', 'Invalid import anchor')
    }
  }
  if (
    (value.owner !== null && !validOwner(value.owner, value.tier)) ||
    (value.formerOwner !== null && !validOwner(value.formerOwner, value.tier))
  ) {
    invalidValidation('incompatible-store', 'Invalid owner binding')
  }
  for (const change of value.metadataHistory) {
    if (
      !isObject(change) ||
      !positiveInt(change.revision) ||
      !isoDate(change.at) ||
      !validActor(change.actor) ||
      (change.before !== null && !isObject(change.before)) ||
      (change.after !== null && !isObject(change.after)) ||
      !Array.isArray(change.changedFields)
    ) {
      invalidValidation('incompatible-store', 'Invalid metadata history')
    }
  }
  return structuredClone(value) as LedgerRecord
}
