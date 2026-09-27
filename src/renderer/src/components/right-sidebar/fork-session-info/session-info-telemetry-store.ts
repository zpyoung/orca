import { useSyncExternalStore } from 'react'
import type {
  SessionInfoPaneTelemetry,
  SessionInfoTelemetrySnapshot
} from '../../../../../shared/fork-session-info/session-info-types'
import { getForkSessionInfoApi } from './session-info-renderer-api'

let snapshot: SessionInfoTelemetrySnapshot = {}
let connectionGeneration = 0
let disconnect: (() => void) | null = null
const panePushRevisions = new Map<string, number>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function acceptPush(telemetry: SessionInfoPaneTelemetry): void {
  panePushRevisions.set(telemetry.paneKey, (panePushRevisions.get(telemetry.paneKey) ?? 0) + 1)
  if (!telemetry.provider) {
    const next = { ...snapshot }
    delete next[telemetry.paneKey]
    snapshot = next
  } else {
    snapshot = { ...snapshot, [telemetry.paneKey]: telemetry }
  }
  emit()
}

export function reconcilePulledSessionInfoTelemetry(
  current: SessionInfoTelemetrySnapshot,
  pulled: SessionInfoTelemetrySnapshot,
  currentPushRevisions: ReadonlyMap<string, number>,
  pullStartRevisions: ReadonlyMap<string, number>
): SessionInfoTelemetrySnapshot {
  const next = { ...current }
  let changed = false
  const paneKeys = new Set([...Object.keys(current), ...Object.keys(pulled)])
  for (const paneKey of paneKeys) {
    if ((currentPushRevisions.get(paneKey) ?? 0) !== (pullStartRevisions.get(paneKey) ?? 0)) {
      continue
    }
    if (Object.hasOwn(pulled, paneKey)) {
      if (next[paneKey] !== pulled[paneKey]) {
        next[paneKey] = pulled[paneKey]
        changed = true
      }
    } else if (Object.hasOwn(next, paneKey)) {
      delete next[paneKey]
      changed = true
    }
  }
  return changed ? next : current
}

function connect(): void {
  if (disconnect) {
    return
  }
  const api = getForkSessionInfoApi()
  if (!api) {
    return
  }
  const generation = ++connectionGeneration
  disconnect = api.onUpdate(acceptPush)
  const pullRevisions = new Map(panePushRevisions)
  void api
    .getSnapshot()
    .then((pulled) => {
      if (generation !== connectionGeneration) {
        return
      }
      const next = reconcilePulledSessionInfoTelemetry(
        snapshot,
        pulled,
        panePushRevisions,
        pullRevisions
      )
      if (next !== snapshot) {
        snapshot = next
        emit()
      }
    })
    .catch(() => undefined)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  connect()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && disconnect) {
      connectionGeneration += 1
      disconnect()
      disconnect = null
    }
  }
}

function getPaneSnapshot(paneKey: string | null): SessionInfoPaneTelemetry | undefined {
  return paneKey ? snapshot[paneKey] : undefined
}

export function useSessionInfoTelemetry(
  paneKey: string | null
): SessionInfoPaneTelemetry | undefined {
  return useSyncExternalStore(
    subscribe,
    () => getPaneSnapshot(paneKey),
    () => undefined
  )
}

export function resetSessionInfoTelemetryForTests(): void {
  connectionGeneration += 1
  disconnect?.()
  disconnect = null
  snapshot = {}
  panePushRevisions.clear()
  listeners.clear()
}
