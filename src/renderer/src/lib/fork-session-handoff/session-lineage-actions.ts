import {
  FORK_SESSION_HANDOFF_LINEAGE_CAP,
  type ForkSessionHandoffLineageRecord,
  type LineageEndpointIdentity
} from '../../../../shared/fork-session-handoff/session-lineage-types'
import { getForkSessionHandoffApi } from './session-handoff-renderer-api'

export type SessionLineageEnrichment = {
  recordId: string
  paneKey?: string | null
  providerSessionId?: string | null
}

type Listener = () => void

const EMPTY_LINEAGE: readonly ForkSessionHandoffLineageRecord[] = []
let cachedLineage: readonly ForkSessionHandoffLineageRecord[] | null = null
let lineageLoad: Promise<readonly ForkSessionHandoffLineageRecord[]> | null = null
const listeners = new Set<Listener>()
const enrichmentQueues = new Map<string, Promise<void>>()

function publish(records: readonly ForkSessionHandoffLineageRecord[]): void {
  cachedLineage = records
  for (const listener of listeners) {
    listener()
  }
}

function newestFirst(
  records: readonly ForkSessionHandoffLineageRecord[]
): ForkSessionHandoffLineageRecord[] {
  return [...records]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, FORK_SESSION_HANDOFF_LINEAGE_CAP)
}

/** Loads persisted lineage once, then serves the module cache. */
export async function listSessionLineage(): Promise<readonly ForkSessionHandoffLineageRecord[]> {
  if (cachedLineage) {
    return cachedLineage
  }
  if (!lineageLoad) {
    lineageLoad = Promise.resolve()
      .then(() => getForkSessionHandoffApi().lineageList())
      .then((records) => {
        const next = newestFirst(records)
        publish(next)
        return next
      })
      .catch(() => {
        publish(EMPTY_LINEAGE)
        return EMPTY_LINEAGE
      })
  }
  return lineageLoad
}

/** Persists one handoff and publishes it to mounted lineage surfaces. */
export async function recordSessionLineage(record: ForkSessionHandoffLineageRecord): Promise<void> {
  await listSessionLineage()
  await getForkSessionHandoffApi().lineageRecord(record)
  publish(newestFirst([record, ...(cachedLineage ?? []).filter((item) => item.id !== record.id)]))
}

function normalizedEnrichment(
  args: SessionLineageEnrichment
): Pick<LineageEndpointIdentity, 'paneKey' | 'providerSessionId'> | null {
  const paneKey = typeof args.paneKey === 'string' ? args.paneKey.trim() : ''
  const providerSessionId =
    typeof args.providerSessionId === 'string' ? args.providerSessionId.trim() : ''
  if (!paneKey && !providerSessionId) {
    return null
  }
  return {
    paneKey: paneKey || null,
    providerSessionId: providerSessionId || null
  }
}

async function applyEnrichment(args: SessionLineageEnrichment): Promise<void> {
  const patch = normalizedEnrichment(args)
  if (!patch) {
    return
  }
  await listSessionLineage()
  const record = cachedLineage?.find((item) => item.id === args.recordId)
  if (!record) {
    return
  }
  const paneKey = record.child.paneKey === null ? patch.paneKey : null
  const providerSessionId = record.child.providerSessionId === null ? patch.providerSessionId : null
  if (!paneKey && !providerSessionId) {
    return
  }

  try {
    await getForkSessionHandoffApi().lineageEnrich({
      recordId: args.recordId,
      ...(paneKey ? { paneKey } : {}),
      ...(providerSessionId ? { providerSessionId } : {})
    })
  } catch {
    return
  }

  publish(
    (cachedLineage ?? []).map((item) =>
      item.id === args.recordId
        ? {
            ...item,
            child: {
              ...item.child,
              paneKey: item.child.paneKey ?? paneKey,
              providerSessionId: item.child.providerSessionId ?? providerSessionId
            }
          }
        : item
    )
  )
}

/** Best-effort, idempotent child identity enrichment with write-through caching. */
export function enrichSessionLineage(args: SessionLineageEnrichment): Promise<void> {
  const previous = enrichmentQueues.get(args.recordId) ?? Promise.resolve()
  const next = previous.then(() => applyEnrichment(args))
  enrichmentQueues.set(args.recordId, next)
  const clearQueue = (): void => {
    if (enrichmentQueues.get(args.recordId) === next) {
      enrichmentQueues.delete(args.recordId)
    }
  }
  void next.then(clearQueue, clearQueue)
  return next
}

/** Returns the stable snapshot consumed by React lineage surfaces. */
export function getSessionLineageSnapshot(): readonly ForkSessionHandoffLineageRecord[] {
  return cachedLineage ?? EMPTY_LINEAGE
}

/** Subscribes to successful cache loads and write-through mutations. */
export function subscribeSessionLineage(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetSessionLineageCacheForTests(): void {
  cachedLineage = null
  lineageLoad = null
  enrichmentQueues.clear()
  listeners.clear()
}
