// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HeimdallApi } from '../../../shared/fork-heimdall/api'
import {
  WatcherFleetEntrySchema,
  type WatcherFleetEntry
} from '../../../shared/fork-heimdall/fleet-types'
import type { ObjectiveDetail } from '../../../shared/fork-heimdall-objective/detail-types'
import { ObjectiveDetailSection } from './ObjectiveDetailSection'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function row(revision: number, observedAtMs = revision): WatcherFleetEntry {
  return WatcherFleetEntrySchema.parse({
    target: { watcherId: 'watcher-1', connectionId: 'hermes', pairingRevision: 7 },
    ownerFence: {
      executionHostId: 'runtime:hermes',
      schedulerOwner: 'remote_host_service',
      workspaceKey: 'runtime:hermes::worktree-1',
      revision
    },
    observedAtMs,
    contact: 'live',
    readOnlyReason: null,
    capabilityNotes: [],
    paused: false,
    entry: {
      name: 'Objective',
      enrollment: {
        watcherId: 'watcher-1',
        kind: 'objective',
        workspaceKey: 'runtime:hermes::worktree-1',
        executionHostId: 'runtime:hermes',
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        workspacePath: '/workspace/repo-1',
        schedulerOwner: 'remote_host_service',
        enabled: true,
        paused: false,
        commandRevision: revision,
        capabilities: {
          plan: 'gated',
          implement: 'on',
          review: 'on',
          check: 'on',
          land: 'on'
        },
        budget: { wallClockActiveMs: 14_400_000, turns: 40 },
        kindPayload: {},
        coordinatorIdentity: { handle: 'main', paneKey: 'pane-1' },
        orchestrationRunId: null,
        createdAtMs: 1,
        terminalAtMs: null
      },
      status: {
        watcherId: 'watcher-1',
        enabled: true,
        state: 'watching',
        phase: 'observe',
        reason: null,
        parkReason: null,
        budget: { activeMs: 0, turns: 0, exhausted: null },
        startedAtMs: 1,
        lastSuccessfulTickAtMs: null,
        nextPulseAtMs: null
      }
    }
  })
}

function detail(objectiveText: string, asOfMs: number): ObjectiveDetail {
  return {
    contract: {
      objectiveText,
      tier: 'standard',
      landingBar: 'files-on-disk',
      maxConcurrency: 1,
      workspaceKind: 'git',
      writeTerritory: ['src/**'],
      roleAgents: {},
      sitterOverrides: {}
    },
    revisions: [],
    nodes: [],
    verdicts: [],
    landing: [],
    asOfMs
  }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

let root: Root
let container: HTMLDivElement
let previousApi: unknown

beforeEach(() => {
  previousApi = window.api
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(async () => {
  await act(async () => root.unmount())
  document.body.replaceChildren()
  Object.defineProperty(window, 'api', { configurable: true, value: previousApi })
})

function installApi(overrides: Partial<HeimdallApi>): void {
  const api = {
    enroll: vi.fn(),
    onFleetChanged: vi.fn(() => () => {}),
    ...overrides
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { heimdall: api }
  })
}

describe('ObjectiveDetailSection', () => {
  it('renders the remote-safe unavailable state when the optional method is absent', async () => {
    installApi({})
    await act(async () => root.render(<ObjectiveDetailSection row={row(1)} />))

    expect(container.textContent).toContain('Objective detail is not available from this host.')
  })

  it('maps an old host unknown-method refusal to the unavailable state', async () => {
    installApi({
      objectiveDetail: vi.fn(() =>
        Promise.reject(new Error('Unknown method: heimdall:objectiveDetail'))
      )
    })
    await act(async () => root.render(<ObjectiveDetailSection row={row(1)} />))
    await flushEffects()

    expect(container.textContent).toContain('Objective detail is not available from this host.')
    expect(container.textContent).not.toContain('could not be loaded')
  })

  it('does not let an older response overwrite a newer owner revision', async () => {
    const first = deferred<ObjectiveDetail>()
    const second = deferred<ObjectiveDetail>()
    const objectiveDetail = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    installApi({ objectiveDetail })

    await act(async () => root.render(<ObjectiveDetailSection row={row(1, 10)} />))
    await flushEffects()
    await act(async () => root.render(<ObjectiveDetailSection row={row(2, 20)} />))
    await flushEffects()
    await act(async () => {
      second.resolve(detail('New owner state', 20))
      await second.promise
    })
    expect(container.textContent).toContain('New owner state')

    await act(async () => {
      first.resolve(detail('Stale owner state', 10))
      await first.promise
    })
    expect(container.textContent).toContain('New owner state')
    expect(container.textContent).not.toContain('Stale owner state')
  })
})
