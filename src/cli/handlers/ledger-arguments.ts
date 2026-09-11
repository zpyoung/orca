import type { LedgerEntryType, LedgerRequest } from '../../shared/ledger'
import type { HandlerContext } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { resolveCurrentWorktreeSelector } from '../selectors'

export const LEDGER_TYPES: readonly LedgerEntryType[] = [
  'bug',
  'deferred',
  'test-gap',
  'proposal',
  'decision'
]
export const LEDGER_STATES = ['open', 'resolved', 'archived'] as const

const CONTENT_FIELDS: Record<string, string> = {
  title: 'title',
  file: 'file',
  description: 'description',
  severity: 'severity',
  'why-deferred': 'why_deferred',
  priority: 'priority',
  'file-under-test': 'file_under_test',
  'reason-skipped': 'reason_skipped',
  context: 'context',
  recommendation: 'recommendation',
  decision: 'decision',
  consequences: 'consequences',
  status: 'status'
}
const REQUIRED_FIELDS: Record<LedgerEntryType, string[]> = {
  bug: ['title', 'file', 'description', 'severity'],
  deferred: ['title', 'why-deferred', 'priority'],
  'test-gap': ['title', 'file-under-test', 'reason-skipped'],
  proposal: ['title', 'context', 'recommendation'],
  decision: ['title', 'context', 'decision', 'consequences', 'status']
}

function stringFlag(ctx: HandlerContext, name: string): string | undefined {
  const value = ctx.flags.get(name)
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function valueFlag(ctx: HandlerContext, name: string): string | undefined {
  if (!ctx.flags.has(name)) {
    return undefined
  }
  const value = stringFlag(ctx, name)
  if (value === undefined) {
    throw new RuntimeClientError('invalid_argument', `--${name} requires a value`)
  }
  return value
}

export function revision(ctx: HandlerContext, name: string): number {
  const value = stringFlag(ctx, name)
  const parsed = value === undefined ? Number.NaN : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be a positive integer`)
  }
  return parsed
}

export function enumFlag<T extends string>(
  ctx: HandlerContext,
  name: string,
  values: readonly T[]
): T | undefined {
  const value = valueFlag(ctx, name)
  if (value === undefined) {
    return undefined
  }
  if (!values.includes(value as T)) {
    throw new RuntimeClientError('invalid_argument', `--${name} must be one of ${values.join('|')}`)
  }
  return value as T
}

export async function target(
  ctx: HandlerContext,
  allowLedger: boolean
): Promise<LedgerRequest['target']> {
  const group = ctx.flags.has('group')
  const selector = stringFlag(ctx, 'group-selector')
  if (group && selector !== undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--group and --group-selector are mutually exclusive'
    )
  }
  if (ctx.flags.has('group-selector') && selector === undefined) {
    throw new RuntimeClientError('invalid_argument', '--group-selector requires a value')
  }
  if (!allowLedger && ctx.flags.has('ledger')) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--ledger is only supported by ledger list, show, and review'
    )
  }
  if (allowLedger && ctx.flags.has('ledger') && (group || selector !== undefined)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--ledger is mutually exclusive with --group and --group-selector'
    )
  }
  const workspaceId = stringFlag(ctx, 'workspace')
  if (ctx.flags.has('workspace') && workspaceId === undefined) {
    throw new RuntimeClientError('invalid_argument', '--workspace requires a value')
  }
  if (ctx.flags.has('ledger') && stringFlag(ctx, 'ledger') === undefined) {
    throw new RuntimeClientError('invalid_argument', '--ledger requires a value')
  }
  if (ctx.flags.has('ledger') && workspaceId !== undefined) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--ledger is mutually exclusive with --workspace'
    )
  }
  const selectedWorkspace =
    workspaceId === 'active' || workspaceId === 'current'
      ? (await resolveCurrentWorktreeSelector(ctx.cwd, ctx.client)).slice(3)
      : workspaceId
  if (!selectedWorkspace && !(allowLedger && stringFlag(ctx, 'ledger'))) {
    return {
      workspaceId: (await resolveCurrentWorktreeSelector(ctx.cwd, ctx.client)).slice(3),
      ...(group ? { group: true } : {}),
      ...(selector ? { groupSelector: selector } : {})
    }
  }
  return {
    ...(selectedWorkspace ? { workspaceId: selectedWorkspace } : {}),
    ...(group ? { group: true } : {}),
    ...(selector ? { groupSelector: selector } : {}),
    ...(allowLedger && stringFlag(ctx, 'ledger') ? { ledgerId: stringFlag(ctx, 'ledger') } : {})
  }
}

export function entryId(ctx: HandlerContext): string {
  const flagged = stringFlag(ctx, 'id')
  if (flagged) {
    return flagged
  }
  const raw = ctx.rawArgs ?? []
  const commandIndex = raw.findIndex(
    (arg) => arg === 'show' || arg === 'edit' || arg === 'state' || arg === 'revert'
  )
  const value = commandIndex >= 0 ? raw[commandIndex + 1] : undefined
  if (value && !value.startsWith('--')) {
    return value
  }
  throw new RuntimeClientError('invalid_argument', 'Missing ledger entry id')
}

export function content(ctx: HandlerContext): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [flag, field] of Object.entries(CONTENT_FIELDS)) {
    const value = valueFlag(ctx, flag)
    if (value !== undefined) {
      result[field] = value
    }
  }
  return result
}

export function validateRequiredContent(
  type: LedgerEntryType,
  value: Record<string, unknown>
): void {
  const missing = REQUIRED_FIELDS[type].find((field) => value[CONTENT_FIELDS[field]] === undefined)
  if (missing) {
    throw new RuntimeClientError('invalid_argument', `Missing required --${missing}`)
  }
}

export function filters(ctx: HandlerContext): LedgerRequest['filters'] {
  const reviewed = valueFlag(ctx, 'reviewed')
  const stale = valueFlag(ctx, 'stale')
  if (reviewed !== undefined && reviewed !== 'true' && reviewed !== 'false') {
    throw new RuntimeClientError('invalid_argument', '--reviewed must be true or false')
  }
  if (stale !== undefined && stale !== 'true' && stale !== 'false') {
    throw new RuntimeClientError('invalid_argument', '--stale must be true or false')
  }
  const type = enumFlag(ctx, 'type', LEDGER_TYPES)
  const state = enumFlag(ctx, 'state', LEDGER_STATES)
  return {
    ...(type ? { type } : {}),
    ...(state ? { state } : {}),
    ...(reviewed !== undefined ? { reviewed: reviewed === 'true' } : {}),
    ...(stale !== undefined ? { stale: stale === 'true' } : {}),
    ...(stringFlag(ctx, 'workspace') ? { workspaceId: stringFlag(ctx, 'workspace') } : {}),
    ...(stringFlag(ctx, 'branch') ? { branch: stringFlag(ctx, 'branch') } : {})
  }
}
