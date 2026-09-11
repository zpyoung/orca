import type { LedgerRequest } from './ledger'
import { validateLedgerContent } from './ledger-content-validation'
import {
  invalidValidation,
  isObject,
  LEDGER_TYPES,
  optionalString,
  positiveInt,
  STATES,
  validOwner
} from './ledger-validation-primitives'

const OPERATIONS = [
  'file',
  'list',
  'show',
  'edit',
  'state',
  'review',
  'revert',
  'import',
  'catalog',
  'approve',
  'bulk-state',
  'delete-entries',
  'delete-ledger',
  'attach',
  'settings',
  'removal-preview'
] as const

function validateTarget(target: unknown): void {
  if (
    !isObject(target) ||
    (target.workspaceId !== undefined && typeof target.workspaceId !== 'string') ||
    (target.ledgerId !== undefined && typeof target.ledgerId !== 'string') ||
    (target.group !== undefined && typeof target.group !== 'boolean') ||
    (target.groupSelector !== undefined && typeof target.groupSelector !== 'string') ||
    (target.owner !== undefined && !validOwner(target.owner))
  ) {
    invalidValidation('invalid-target', 'Invalid ledger target')
  }
  const selectors = [target.workspaceId, target.owner, target.ledgerId].filter(
    (value) => value !== undefined
  )
  const grouped = target.group === true || target.groupSelector !== undefined
  if (
    selectors.length > 1 ||
    (target.group && target.groupSelector !== undefined) ||
    target.groupSelector === '' ||
    (grouped && !target.workspaceId)
  ) {
    invalidValidation(
      'invalid-target',
      'Target selectors are mutually exclusive; group selection requires a workspace'
    )
  }
}

function validateSelections(selections: unknown): void {
  if (!Array.isArray(selections)) {
    invalidValidation('invalid-selection', 'Selections must be an array')
  }
  const ids = new Set<string>()
  for (const selection of selections) {
    if (
      !isObject(selection) ||
      typeof selection.id !== 'string' ||
      !positiveInt(selection.revision) ||
      ids.has(selection.id)
    ) {
      invalidValidation(
        'invalid-selection',
        'Selections must contain unique IDs and safe revisions'
      )
    }
    ids.add(selection.id)
  }
}

function validateRemoval(removal: unknown): void {
  if (
    !isObject(removal) ||
    (removal.repoId !== undefined && typeof removal.repoId !== 'string') ||
    (removal.projectGroupId !== undefined && typeof removal.projectGroupId !== 'string') ||
    (removal.repoIds !== undefined &&
      (!Array.isArray(removal.repoIds) || removal.repoIds.some((id) => typeof id !== 'string'))) ||
    (removal.removeContainedProjects !== undefined &&
      typeof removal.removeContainedProjects !== 'boolean') ||
    (removal.expectedLedgers !== undefined &&
      (!Array.isArray(removal.expectedLedgers) ||
        removal.expectedLedgers.some(
          (entry) =>
            !isObject(entry) || typeof entry.ledgerId !== 'string' || !positiveInt(entry.revision)
        )))
  ) {
    invalidValidation('invalid-removal', 'Invalid removal metadata')
  }
}

export function validateLedgerRequest(request: LedgerRequest): void {
  if (!isObject(request) || !OPERATIONS.includes(request.operation as never)) {
    invalidValidation('invalid-request', 'Unsupported or missing ledger operation')
  }
  const q = request
  if (q.target !== undefined) {
    validateTarget(q.target)
  }
  if (q.ifRevision !== undefined && !positiveInt(q.ifRevision)) {
    invalidValidation('invalid-revision', 'ifRevision must be a positive safe integer')
  }
  if (q.toRevision !== undefined && !positiveInt(q.toRevision)) {
    invalidValidation('invalid-revision', 'toRevision must be a positive safe integer')
  }
  if (
    q.ifLedgerRevision !== undefined &&
    (!Number.isSafeInteger(q.ifLedgerRevision) || q.ifLedgerRevision < 0)
  ) {
    invalidValidation('invalid-revision', 'ifLedgerRevision must be a safe integer')
  }
  if (q.type !== undefined && !LEDGER_TYPES.includes(q.type)) {
    invalidValidation('invalid-type', 'Invalid entry type')
  }
  if (q.state !== undefined && !STATES.includes(q.state)) {
    invalidValidation('invalid-state', 'Invalid lifecycle state')
  }
  if (q.content !== undefined && !isObject(q.content)) {
    invalidValidation('invalid-content', 'Content must be an object')
  }
  if (
    q.filters !== undefined &&
    (!isObject(q.filters) ||
      (q.filters.type !== undefined && !LEDGER_TYPES.includes(q.filters.type)) ||
      (q.filters.state !== undefined && !STATES.includes(q.filters.state)) ||
      (q.filters.reviewed !== undefined && typeof q.filters.reviewed !== 'boolean') ||
      (q.filters.stale !== undefined && typeof q.filters.stale !== 'boolean') ||
      !optionalString(q.filters.workspaceId) ||
      !optionalString(q.filters.branch))
  ) {
    invalidValidation('invalid-filter', 'Invalid ledger filter')
  }
  if (q.selections !== undefined) {
    validateSelections(q.selections)
  }
  validateOperation(q)
  if (q.confirmed !== undefined && typeof q.confirmed !== 'boolean') {
    invalidValidation('invalid-request', 'confirmed must be boolean')
  }
  if (q.removal !== undefined) {
    validateRemoval(q.removal)
  }
}

function validateOperation(q: LedgerRequest): void {
  switch (q.operation) {
    case 'file':
      if (!q.type || !q.content) {
        invalidValidation('invalid-request', 'file requires type and content')
      }
      validateLedgerContent(q.type, q.content)
      break
    case 'edit':
      if (!q.id || !q.content || q.ifRevision === undefined) {
        invalidValidation('invalid-request', 'edit requires id, content, and ifRevision')
      }
      break
    case 'state':
      if (!q.id || !q.state || q.ifRevision === undefined) {
        invalidValidation('invalid-request', 'state requires id, state, and ifRevision')
      }
      break
    case 'show':
      if (!q.id) {
        invalidValidation('invalid-request', 'show requires id')
      }
      break
    case 'revert':
      if (!q.id || q.toRevision === undefined || q.ifRevision === undefined) {
        invalidValidation('invalid-request', 'revert requires id, toRevision, and ifRevision')
      }
      break
    case 'bulk-state':
      if (!q.state || !q.selections) {
        invalidValidation('invalid-request', 'bulk-state requires state and selections')
      }
      break
    case 'approve':
      if (!q.selections) {
        invalidValidation('invalid-request', 'approve requires selections')
      }
      break
    case 'settings':
      if (
        q.ifLedgerRevision === undefined ||
        (q.staleAfterDays !== undefined &&
          (!Number.isSafeInteger(q.staleAfterDays) || q.staleAfterDays < 0))
      ) {
        invalidValidation(
          'invalid-settings',
          'settings requires ifLedgerRevision and a valid stale threshold'
        )
      }
      break
    case 'attach':
      if (
        q.ifLedgerRevision === undefined ||
        q.attachTo === undefined ||
        !validOwner(q.attachTo) ||
        q.confirmed !== true
      ) {
        invalidValidation(
          'invalid-request',
          'attach requires confirmation, target owner, and ifLedgerRevision'
        )
      }
      break
    case 'delete-ledger':
      if (q.ifLedgerRevision === undefined || q.confirmed !== true) {
        invalidValidation(
          'invalid-request',
          'delete-ledger requires confirmation and ifLedgerRevision'
        )
      }
      break
    case 'delete-entries':
      if (!q.selections) {
        invalidValidation('invalid-request', 'delete-entries requires selections')
      }
      break
    case 'list':
    case 'review':
    case 'import':
    case 'catalog':
    case 'removal-preview':
      break
  }
}
