import type {
  ForkHandoffRelationship,
  ForkSessionHandoffLineageRecord,
  LineageEndpointIdentity
} from '../../shared/fork-session-handoff/session-lineage-types'
import { FORK_SESSION_HANDOFF_LINEAGE_VERSION } from '../../shared/fork-session-handoff/session-lineage-types'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import type { TuiAgent } from '../../shared/tui-agent'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const RELATIONSHIPS = new Set<ForkHandoffRelationship>(['continues', 'reviews', 'branches-from'])

export type ForkSessionHandoffLineageEnrichment = {
  recordId: string
  paneKey?: string | null
  providerSessionId?: string | null
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readNullableString(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined
}

function readOptionalIdentityString(value: unknown, present: boolean): string | null | undefined {
  if (!present) {
    return undefined
  }
  if (value === null) {
    return null
  }
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function readAgent(value: unknown): TuiAgent | null | undefined {
  if (value === null) {
    return null
  }
  if (typeof value !== 'string' || !Object.hasOwn(TUI_AGENT_CONFIG, value)) {
    return undefined
  }
  return value as TuiAgent
}

function parseEndpoint(value: unknown): LineageEndpointIdentity | null {
  if (!isObject(value)) {
    return null
  }
  const paneKey = readNullableString(value.paneKey)
  const agent = readAgent(value.agent)
  const providerSessionId = readNullableString(value.providerSessionId)
  const transcriptPath = readNullableString(value.transcriptPath)
  const worktreeId = readNullableString(value.worktreeId)
  const title = readNullableString(value.title)
  if (
    paneKey === undefined ||
    agent === undefined ||
    providerSessionId === undefined ||
    transcriptPath === undefined ||
    worktreeId === undefined ||
    title === undefined
  ) {
    return null
  }
  return { paneKey, agent, providerSessionId, transcriptPath, worktreeId, title }
}

/** Validate and sanitize one lineage record received from disk or IPC. */
export function parseForkSessionHandoffLineageRecord(
  value: unknown
): ForkSessionHandoffLineageRecord | null {
  if (!isObject(value)) {
    return null
  }
  const parent = parseEndpoint(value.parent)
  const childEndpoint = parseEndpoint(value.child)
  const childValue = isObject(value.child) ? value.child : null
  const tabId = childValue ? readNullableString(childValue.tabId) : undefined
  if (
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.createdAt !== 'number' ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    typeof value.relationship !== 'string' ||
    !RELATIONSHIPS.has(value.relationship as ForkHandoffRelationship) ||
    !parent ||
    !childEndpoint ||
    tabId === undefined
  ) {
    return null
  }
  return {
    id: value.id,
    createdAt: value.createdAt,
    relationship: value.relationship as ForkHandoffRelationship,
    parent,
    child: { ...childEndpoint, tabId }
  }
}

/** Validate and sanitize a child-identity enrichment received over IPC. */
export function parseForkSessionHandoffLineageEnrichment(
  value: unknown
): ForkSessionHandoffLineageEnrichment | null {
  if (
    !isObject(value) ||
    typeof value.recordId !== 'string' ||
    !UUID_PATTERN.test(value.recordId)
  ) {
    return null
  }
  const hasPaneKey = Object.hasOwn(value, 'paneKey')
  const hasProviderSessionId = Object.hasOwn(value, 'providerSessionId')
  const paneKey = readOptionalIdentityString(value.paneKey, hasPaneKey)
  const providerSessionId = readOptionalIdentityString(
    value.providerSessionId,
    hasProviderSessionId
  )
  if (
    (hasPaneKey && paneKey === undefined) ||
    (hasProviderSessionId && providerSessionId === undefined) ||
    (typeof paneKey !== 'string' && typeof providerSessionId !== 'string')
  ) {
    return null
  }
  return {
    recordId: value.recordId,
    ...(hasPaneKey ? { paneKey } : {}),
    ...(hasProviderSessionId ? { providerSessionId } : {})
  }
}

/**
 * Validate and sanitize the complete versioned lineage file.
 *
 * Returns null only when the file itself cannot be interpreted (wrong version, no record
 * array). Individual unreadable records are dropped, because the caller treats null as
 * "start empty" and would otherwise overwrite every surviving record.
 */
export function parseForkSessionHandoffLineageFile(
  value: unknown
): ForkSessionHandoffLineageRecord[] | null {
  if (
    !isObject(value) ||
    value.version !== FORK_SESSION_HANDOFF_LINEAGE_VERSION ||
    !Array.isArray(value.records)
  ) {
    return null
  }
  const records: ForkSessionHandoffLineageRecord[] = []
  for (const valueRecord of value.records) {
    const record = parseForkSessionHandoffLineageRecord(valueRecord)
    if (record) {
      records.push(record)
    }
  }
  return records
}
