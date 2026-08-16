// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_GUTTER_ROWS,
  hasTerminalDockPaneState,
  MAX_GUTTER_ROWS,
  MAX_STORED_PANE_ENTRIES,
  MIN_GUTTER_ROWS,
  readTerminalDockPaneState,
  rekeyTerminalDockPaneKeys,
  removeTerminalDockPaneKeys,
  writeTerminalDockPaneState
} from './terminal-dock-pane-state'

const STORAGE_KEY = 'orca.terminalDock.paneState.v1'

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  window.localStorage.clear()
})

describe('readTerminalDockPaneState', () => {
  it('defaults to not docked with the default gutter height when absent', () => {
    expect(readTerminalDockPaneState('pane-1')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
  })

  it('distinguishes absent state from an explicit undocked decision', () => {
    expect(hasTerminalDockPaneState('pane-1')).toBe(false)
    writeTerminalDockPaneState('pane-1', { docked: false, gutterRows: 5 })
    expect(hasTerminalDockPaneState('pane-1')).toBe(true)
  })

  it('round-trips a written value through localStorage', () => {
    writeTerminalDockPaneState('pane-1', { docked: true, gutterRows: 8 })
    expect(readTerminalDockPaneState('pane-1')).toEqual({ docked: true, gutterRows: 8 })
    const raw = window.localStorage.getItem(STORAGE_KEY)
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw as string)).toEqual({ 'pane-1': { docked: true, gutterRows: 8 } })
  })

  it('clamps gutterRows above the max on write', () => {
    writeTerminalDockPaneState('pane-1', { docked: true, gutterRows: 999 })
    expect(readTerminalDockPaneState('pane-1').gutterRows).toBe(MAX_GUTTER_ROWS)
  })

  it('clamps gutterRows below the min on write', () => {
    writeTerminalDockPaneState('pane-1', { docked: true, gutterRows: -5 })
    expect(readTerminalDockPaneState('pane-1').gutterRows).toBe(MIN_GUTTER_ROWS)
  })

  it('clamps an out-of-range gutterRows found directly in storage on read', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ 'pane-1': { docked: true, gutterRows: 42 } })
    )
    expect(readTerminalDockPaneState('pane-1')).toEqual({
      docked: true,
      gutterRows: MAX_GUTTER_ROWS
    })
  })

  it('drops a malformed entry rather than throwing', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        'pane-1': { docked: 'yes', gutterRows: 5 },
        'pane-2': { docked: true },
        'pane-3': 'not-an-object',
        'pane-4': { docked: true, gutterRows: 6 }
      })
    )
    expect(readTerminalDockPaneState('pane-1')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
    expect(readTerminalDockPaneState('pane-2')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
    expect(readTerminalDockPaneState('pane-3')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
    expect(readTerminalDockPaneState('pane-4')).toEqual({ docked: true, gutterRows: 6 })
  })

  it('survives corrupt JSON without throwing', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json')
    expect(readTerminalDockPaneState('pane-1')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
  })

  it('rejects unsafe keys read from storage', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        __proto__: { docked: true, gutterRows: 9 },
        constructor: { docked: true, gutterRows: 9 },
        prototype: { docked: true, gutterRows: 9 }
      })
    )
    expect(readTerminalDockPaneState('__proto__')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
    expect(readTerminalDockPaneState('constructor')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

describe('removeTerminalDockPaneKeys', () => {
  it('prunes entries for panes that no longer exist', () => {
    writeTerminalDockPaneState('pane-1', { docked: true, gutterRows: 6 })
    writeTerminalDockPaneState('pane-2', { docked: true, gutterRows: 7 })
    writeTerminalDockPaneState('pane-3', { docked: true, gutterRows: 8 })

    removeTerminalDockPaneKeys(new Set(['pane-1', 'pane-3']))

    expect(readTerminalDockPaneState('pane-1')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
    expect(readTerminalDockPaneState('pane-2')).toEqual({ docked: true, gutterRows: 7 })
    expect(readTerminalDockPaneState('pane-3')).toEqual({
      docked: false,
      gutterRows: DEFAULT_GUTTER_ROWS
    })
  })

  it('is a no-op for keys that are not present', () => {
    writeTerminalDockPaneState('pane-1', { docked: true, gutterRows: 6 })
    removeTerminalDockPaneKeys(new Set(['pane-does-not-exist']))
    expect(readTerminalDockPaneState('pane-1')).toEqual({ docked: true, gutterRows: 6 })
  })
})

describe('rekeyTerminalDockPaneKeys', () => {
  it('moves entries under the old tab id to the new tab id, preserving leaf ids and values', () => {
    writeTerminalDockPaneState('provisional-1:leaf-a', { docked: true, gutterRows: 6 })
    writeTerminalDockPaneState('provisional-1:leaf-b', { docked: false, gutterRows: 8 })
    writeTerminalDockPaneState('other-tab:leaf-c', { docked: true, gutterRows: 4 })

    rekeyTerminalDockPaneKeys('provisional-1', 'web-terminal-host-1')

    expect(hasTerminalDockPaneState('provisional-1:leaf-a')).toBe(false)
    expect(hasTerminalDockPaneState('provisional-1:leaf-b')).toBe(false)
    expect(readTerminalDockPaneState('web-terminal-host-1:leaf-a')).toEqual({
      docked: true,
      gutterRows: 6
    })
    expect(readTerminalDockPaneState('web-terminal-host-1:leaf-b')).toEqual({
      docked: false,
      gutterRows: 8
    })
    expect(readTerminalDockPaneState('other-tab:leaf-c')).toEqual({ docked: true, gutterRows: 4 })
  })

  it('keeps the pre-existing target entry on collision and drops the source (target wins)', () => {
    writeTerminalDockPaneState('provisional-1:leaf-a', { docked: true, gutterRows: 6 })
    writeTerminalDockPaneState('web-terminal-host-1:leaf-a', { docked: false, gutterRows: 9 })

    rekeyTerminalDockPaneKeys('provisional-1', 'web-terminal-host-1')

    expect(hasTerminalDockPaneState('provisional-1:leaf-a')).toBe(false)
    expect(readTerminalDockPaneState('web-terminal-host-1:leaf-a')).toEqual({
      docked: false,
      gutterRows: 9
    })
  })

  it('is a no-op when there is nothing under the old tab id', () => {
    writeTerminalDockPaneState('other-tab:leaf-c', { docked: true, gutterRows: 4 })
    rekeyTerminalDockPaneKeys('provisional-1', 'web-terminal-host-1')
    expect(readTerminalDockPaneState('other-tab:leaf-c')).toEqual({ docked: true, gutterRows: 4 })
    expect(hasTerminalDockPaneState('web-terminal-host-1:leaf-c')).toBe(false)
  })

  it('rejects unsafe tab ids', () => {
    writeTerminalDockPaneState('__proto__:leaf-a', { docked: true, gutterRows: 6 })
    rekeyTerminalDockPaneKeys('__proto__', 'web-terminal-host-1')
    rekeyTerminalDockPaneKeys('provisional-1', '__proto__')
    expect(hasTerminalDockPaneState('web-terminal-host-1:leaf-a')).toBe(false)
  })
})

describe('writeTerminalDockPaneState bound', () => {
  it('evicts the oldest entries once the stored map exceeds the cap', () => {
    for (let i = 0; i < MAX_STORED_PANE_ENTRIES; i++) {
      writeTerminalDockPaneState(`pane-${i}`, { docked: true, gutterRows: 5 })
    }
    writeTerminalDockPaneState('pane-overflow', { docked: true, gutterRows: 5 })

    expect(hasTerminalDockPaneState('pane-0')).toBe(false)
    expect(hasTerminalDockPaneState('pane-1')).toBe(true)
    expect(hasTerminalDockPaneState('pane-overflow')).toBe(true)
    const raw = window.localStorage.getItem(STORAGE_KEY)
    expect(Object.keys(JSON.parse(raw as string))).toHaveLength(MAX_STORED_PANE_ENTRIES)
  })

  it('moves a rewritten key to the newest position instead of leaving it at its original spot', () => {
    writeTerminalDockPaneState('pane-a', { docked: true, gutterRows: 5 })
    writeTerminalDockPaneState('pane-b', { docked: true, gutterRows: 5 })
    writeTerminalDockPaneState('pane-a', { docked: false, gutterRows: 6 })

    const raw = window.localStorage.getItem(STORAGE_KEY)
    expect(Object.keys(JSON.parse(raw as string))).toEqual(['pane-b', 'pane-a'])
  })

  it('never evicts a just-rewritten live pane, evicting the oldest untouched key instead', () => {
    for (let i = 0; i < MAX_STORED_PANE_ENTRIES; i++) {
      writeTerminalDockPaneState(`pane-${i}`, { docked: true, gutterRows: 5 })
    }
    // pane-0 is the oldest entry; rewriting it should refresh its recency and save it from
    // the eviction its original insertion-order position would otherwise incur.
    writeTerminalDockPaneState('pane-0', { docked: false, gutterRows: 6 })
    writeTerminalDockPaneState('pane-overflow', { docked: true, gutterRows: 5 })

    expect(hasTerminalDockPaneState('pane-0')).toBe(true)
    expect(hasTerminalDockPaneState('pane-1')).toBe(false)
    expect(hasTerminalDockPaneState('pane-overflow')).toBe(true)
  })
})
