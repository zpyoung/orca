// Why: renderer-only UI preference (not synced settings), same rationale as
// column-widths.ts — a per-pane resize/toggle would be a noisy settings write.
import type { TerminalDockPaneState } from '../../../../shared/types'

const STORAGE_KEY = 'orca.terminalDock.paneState.v1'

export const DEFAULT_GUTTER_ROWS = 5
export const MIN_GUTTER_ROWS = 3
export const MAX_GUTTER_ROWS = 15

export const DEFAULT_TERMINAL_DOCK_PANE_STATE: TerminalDockPaneState = {
  docked: false,
  gutterRows: DEFAULT_GUTTER_ROWS
}

type StoredMap = Record<string, TerminalDockPaneState>

function isUnsafeObjectKey(key: string): boolean {
  return key === '__proto__' || key === 'constructor' || key === 'prototype'
}

function clampGutterRows(value: number): number {
  return Math.min(MAX_GUTTER_ROWS, Math.max(MIN_GUTTER_ROWS, Math.round(value)))
}

function isValidStoredEntry(value: unknown): value is { docked: boolean; gutterRows: number } {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as { docked?: unknown; gutterRows?: unknown }
  return typeof candidate.docked === 'boolean' && Number.isFinite(candidate.gutterRows)
}

function readStoredMap(): StoredMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return Object.create(null) as StoredMap
    }
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return Object.create(null) as StoredMap
    }
    // Why: a null-prototype map means `map['__proto__']` misses rather than
    // returning Object.prototype, so an unsafe key can't masquerade as data.
    const next: StoredMap = Object.create(null) as StoredMap
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isUnsafeObjectKey(key) || !isValidStoredEntry(value)) {
        continue
      }
      next[key] = { docked: value.docked, gutterRows: clampGutterRows(value.gutterRows) }
    }
    return next
  } catch {
    return Object.create(null) as StoredMap
  }
}

function writeStoredMap(map: StoredMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // localStorage may be disabled — dock state just won't persist this session.
  }
}

/** Per-pane dock UI state; absent panes read as not docked at the default
 *  gutter height rather than throwing or requiring a caller-side default. */
export function readTerminalDockPaneState(paneKey: string): TerminalDockPaneState {
  if (isUnsafeObjectKey(paneKey)) {
    return DEFAULT_TERMINAL_DOCK_PANE_STATE
  }
  const map = readStoredMap()
  return map[paneKey] ?? DEFAULT_TERMINAL_DOCK_PANE_STATE
}

/** Distinguishes a deliberate local undock from the absent-state default. */
export function hasTerminalDockPaneState(paneKey: string): boolean {
  if (isUnsafeObjectKey(paneKey)) {
    return false
  }
  return Object.hasOwn(readStoredMap(), paneKey)
}

export function writeTerminalDockPaneState(paneKey: string, state: TerminalDockPaneState): void {
  if (isUnsafeObjectKey(paneKey)) {
    return
  }
  const map = readStoredMap()
  map[paneKey] = { docked: state.docked, gutterRows: clampGutterRows(state.gutterRows) }
  writeStoredMap(map)
}

/** Drops dock state for panes that no longer exist, e.g. after a split closes. */
export function removeTerminalDockPaneKeys(paneKeys: ReadonlySet<string>): void {
  if (paneKeys.size === 0) {
    return
  }
  const map = readStoredMap()
  let changed = false
  for (const key of paneKeys) {
    if (key in map) {
      delete map[key]
      changed = true
    }
  }
  if (changed) {
    writeStoredMap(map)
  }
}
