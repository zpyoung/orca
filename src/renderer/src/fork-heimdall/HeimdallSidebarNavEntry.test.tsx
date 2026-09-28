// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { WatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-types'
import { buildWatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-test-fixtures'
import type { WatcherStatusState } from '../../../shared/fork-heimdall/watcher-types'
import { HeimdallSidebarNavEntry } from './HeimdallSidebarNavEntry'

const initialState = useAppStore.getInitialState()
let root: Root | null = null
let container: HTMLDivElement

function fleetRow(
  watcherId: string,
  state: WatcherStatusState,
  options: { contact?: WatcherFleetEntry['contact']; paused?: boolean; reason?: string } = {}
): WatcherFleetEntry {
  const base = buildWatcherFleetEntry(1, 1, watcherId)
  return {
    ...base,
    contact: options.contact ?? base.contact,
    paused: options.paused ?? base.paused,
    entry: {
      ...base.entry,
      status: {
        ...base.entry.status,
        state,
        reason: options.reason ?? null
      }
    }
  }
}

async function renderEntry(): Promise<void> {
  await act(async () => {
    root?.render(<HeimdallSidebarNavEntry />)
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useAppStore.setState({ ...initialState, heimdallFleet: null }, true)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
  useAppStore.setState(initialState, true)
})

describe('HeimdallSidebarNavEntry', () => {
  it('shows only nonzero attention, lost contact and active buckets for a mixed fleet', async () => {
    useAppStore.setState({
      heimdallFleet: {
        entries: [
          fleetRow('escalated', 'escalated'),
          fleetRow('watching', 'watching'),
          fleetRow('unverifiable', 'watching', { contact: 'unverifiable' }),
          fleetRow('terminal', 'terminal'),
          fleetRow('paused', 'held', { paused: true, reason: 'paused' })
        ],
        generatedAtMs: 1
      }
    })

    await renderEntry()

    expect(container.querySelector('[aria-label="Needs you: 1"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Lost contact: 1"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Active: 1"]')).not.toBeNull()
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(3)
    expect(container.querySelector('[aria-label^="Inactive:"]')).toBeNull()
    expect(container.textContent).toContain('Heimdall')
  })

  it('omits zero-count buckets when only one is represented', async () => {
    useAppStore.setState({
      heimdallFleet: { entries: [fleetRow('watching', 'watching')], generatedAtMs: 1 }
    })

    await renderEntry()

    expect(container.querySelector('[aria-label="Active: 1"]')).not.toBeNull()
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(1)
  })

  it('renders no indicators for an empty fleet or a null fleet', async () => {
    await renderEntry()
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0)

    await act(async () => {
      useAppStore.setState({ heimdallFleet: { entries: [], generatedAtMs: 1 } })
    })
    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0)
  })

  it('renders no indicators for an all-inactive fleet', async () => {
    useAppStore.setState({
      heimdallFleet: {
        entries: [fleetRow('terminal', 'terminal'), fleetRow('disabled', 'disabled')],
        generatedAtMs: 1
      }
    })

    await renderEntry()

    expect(container.querySelectorAll('[aria-label]')).toHaveLength(0)
    expect(container.textContent).toContain('Heimdall')
  })
})
