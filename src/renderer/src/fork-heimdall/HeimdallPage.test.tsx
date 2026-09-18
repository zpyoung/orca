// @vitest-environment happy-dom

import { StrictMode, act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  WatcherDetailSchema,
  WatcherFleetEntrySchema,
  type WatcherDetail,
  type WatcherFleetEntry
} from '../../../shared/fork-heimdall/fleet-types'
import HeimdallPage from './HeimdallPage'

vi.mock('./HeimdallDetailPane', () => ({ HeimdallDetailPane: () => null }))
vi.mock('./HeimdallFleetList', () => ({ HeimdallFleetList: () => null }))
vi.mock('../fork-heimdall-objective/ObjectiveEnrollmentSheet', () => ({
  ObjectiveEnrollmentSheet: () => null
}))

function deferred<T>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>()
}

function row(
  revision: number,
  observedAtMs = revision,
  watcherId = 'watcher-1'
): WatcherFleetEntry {
  return WatcherFleetEntrySchema.parse({
    target: { watcherId, connectionId: 'hermes', pairingRevision: 7 },
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
      name: `Objective ${watcherId}`,
      enrollment: {
        watcherId,
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
        watcherId,
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

function detail(watcher: WatcherFleetEntry, actionKind: string, atMs: number): WatcherDetail {
  return WatcherDetailSchema.parse({
    watcher,
    ledger: {
      watcherId: watcher.target.watcherId,
      entries: [
        {
          eventId: `event-${actionKind}`,
          watcherId: watcher.target.watcherId,
          atMs,
          origin: 'owner',
          class: 'fact',
          kind: 'attempt',
          attemptId: `attempt-${actionKind}`,
          fingerprint: `fingerprint-${actionKind}`,
          action: {
            kind: actionKind,
            capability: 'implement',
            visibility: 'local',
            contentIdentity: `content-${actionKind}`,
            evidenceKey: `evidence-${actionKind}`
          },
          state: 'settled',
          effect: 'landed'
        }
      ]
    },
    traces: [],
    workers: []
  })
}

const initialState = useAppStore.getInitialState()
let root: Root | null = null
let container: HTMLDivElement
let previousApi: unknown

function installDetailApi(
  loadDetail: (target: WatcherFleetEntry['target']) => Promise<WatcherDetail>
): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      heimdall: {
        fleet: vi.fn(),
        detail: vi.fn(loadDetail),
        command: vi.fn(),
        debugReport: vi.fn(),
        onFleetChanged: vi.fn(() => () => {})
      }
    }
  })
}

async function renderPage(child: ReactNode): Promise<void> {
  await act(async () => {
    root?.render(child)
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  previousApi = window.api
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useAppStore.setState(
    {
      ...initialState,
      heimdallFleet: { entries: [row(1, 10)], generatedAtMs: 10 },
      heimdallFleetLoading: false,
      heimdallFleetError: null,
      heimdallSelectedTarget: null
    },
    true
  )
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
  useAppStore.setState(initialState, true)
  Object.defineProperty(window, 'api', { configurable: true, value: previousApi })
})

describe('HeimdallPage fleet action history', () => {
  it('commits the initial detail request across StrictMode and equivalent fleet snapshots', async () => {
    const pending = deferred<WatcherDetail>()
    const loadDetail = vi.fn(() => pending.promise)
    installDetailApi(loadDetail)

    await renderPage(
      <StrictMode>
        <HeimdallPage />
      </StrictMode>
    )
    expect(loadDetail).toHaveBeenCalledOnce()

    await act(async () => {
      useAppStore
        .getState()
        .applyHeimdallFleetSnapshot({ entries: [row(1, 10)], generatedAtMs: 11 })
    })
    expect(loadDetail).toHaveBeenCalledOnce()

    await act(async () => {
      pending.resolve(detail(row(1, 10), 'initial-action', 10))
      await pending.promise
      await Promise.resolve()
    })

    expect(container.textContent).toContain('initial-action')
    expect(container.textContent).not.toContain('No autonomous actions recorded yet.')
  })

  it('keeps confirmed actions visible until a background refresh replaces them', async () => {
    const refreshed = deferred<WatcherDetail>()
    const loadDetail = vi
      .fn()
      .mockResolvedValueOnce(detail(row(1, 10), 'old-action', 10))
      .mockImplementationOnce(() => refreshed.promise)
    installDetailApi(loadDetail)

    await renderPage(<HeimdallPage />)
    await flushEffects()
    expect(container.textContent).toContain('old-action')

    await act(async () => {
      useAppStore
        .getState()
        .applyHeimdallFleetSnapshot({ entries: [row(2, 20)], generatedAtMs: 20 })
      await Promise.resolve()
    })

    expect(loadDetail).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('old-action')

    await act(async () => {
      refreshed.resolve(detail(row(2, 20), 'new-action', 20))
      await refreshed.promise
      await Promise.resolve()
    })

    expect(container.textContent).toContain('new-action')
    expect(container.textContent).not.toContain('old-action')
  })

  it('refreshes detail only for the watcher whose per-row stamp changed', async () => {
    let watcherA = row(1, 10, 'watcher-a')
    const watcherB = row(1, 10, 'watcher-b')
    const loadDetail = vi.fn(async (target: WatcherFleetEntry['target']) => {
      const watcher = target.watcherId === 'watcher-a' ? watcherA : watcherB
      return detail(watcher, `${target.watcherId}-action`, watcher.observedAtMs)
    })
    installDetailApi(loadDetail)
    useAppStore.setState({
      heimdallFleet: { entries: [watcherA, watcherB], generatedAtMs: 10 }
    })

    await renderPage(<HeimdallPage />)
    await flushEffects()
    expect(loadDetail).toHaveBeenCalledTimes(2)

    watcherA = row(1, 20, 'watcher-a')
    await act(async () => {
      useAppStore.getState().applyHeimdallFleetSnapshot({
        entries: [watcherA, watcherB],
        generatedAtMs: 20
      })
      await Promise.resolve()
    })
    await flushEffects()

    expect(loadDetail).toHaveBeenCalledTimes(3)
    expect(
      loadDetail.mock.calls.filter(([target]) => target.watcherId === 'watcher-b')
    ).toHaveLength(1)
  })

  it('re-requests every invalidated pending target when one watcher changes', async () => {
    const watcherA = row(1, 10, 'watcher-a')
    const watcherB = row(1, 10, 'watcher-b')
    const initialA = deferred<WatcherDetail>()
    const initialB = deferred<WatcherDetail>()
    const refreshedA = deferred<WatcherDetail>()
    const refreshedB = deferred<WatcherDetail>()
    const pendingByWatcher: Record<string, PromiseWithResolvers<WatcherDetail>[]> = {
      'watcher-a': [initialA, refreshedA],
      'watcher-b': [initialB, refreshedB]
    }
    const loadDetail = vi.fn((target: WatcherFleetEntry['target']) => {
      const request = pendingByWatcher[target.watcherId]?.shift()
      if (!request) {
        throw new Error(`Unexpected detail request for ${target.watcherId}`)
      }
      return request.promise
    })
    installDetailApi(loadDetail)
    useAppStore.setState({
      heimdallFleet: { entries: [watcherA, watcherB], generatedAtMs: 10 }
    })

    await renderPage(<HeimdallPage />)
    expect(loadDetail).toHaveBeenCalledTimes(2)

    const changedWatcherB = row(2, 20, 'watcher-b')
    await act(async () => {
      useAppStore.getState().applyHeimdallFleetSnapshot({
        entries: [watcherA, changedWatcherB],
        generatedAtMs: 20
      })
      await Promise.resolve()
    })

    expect(loadDetail).toHaveBeenCalledTimes(4)
    await act(async () => {
      refreshedA.resolve(detail(watcherA, 'watcher-a-action', 20))
      refreshedB.resolve(detail(changedWatcherB, 'watcher-b-action', 20))
      await Promise.all([refreshedA.promise, refreshedB.promise])
      await Promise.resolve()
    })

    expect(container.textContent).toContain('watcher-a-action')
    expect(container.textContent).toContain('watcher-b-action')
  })
})
