// @vitest-environment happy-dom

import { act, createElement, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LedgerEntry, LedgerResponse } from '../../../../shared/ledger'
import { LedgerError } from '../../../../shared/ledger'
import { requestLedger } from '@/runtime/runtime-ledger-client'
import { useLedgerRequest } from './use-ledger-request'

vi.mock('@/runtime/runtime-ledger-client', () => ({ requestLedger: vi.fn() }))
vi.mock('@/store', () => {
  throw new Error('The local ledger hook must not import the singleton store')
})

type Options = Parameters<typeof useLedgerRequest>[0]
type Result = ReturnType<typeof useLedgerRequest>
const runtime = { runtimeId: 'runtime', profileId: 'profile' }
const targetA = { workspaceId: 'workspace-a' }
const targetB = { workspaceId: 'folder:b' }
const initial: Options = { target: targetA, environmentId: 'paired-a', isVisible: true }
const mockedRequest = vi.mocked(requestLedger)
let root: Root
let latest: Result
let commits: Result[]

function response(id: string): LedgerResponse {
  const entry: LedgerEntry = {
    id,
    type: 'bug',
    sequence: 1,
    revision: 1,
    content: { title: id },
    state: 'open',
    reviewed: false,
    origin: {},
    createdAt: '2026-09-11',
    updatedAt: '2026-09-11',
    history: [],
    latestContentActor: { kind: 'human', model: null, providerSessionId: null }
  }
  return {
    schemaVersion: 1,
    runtime,
    entries: [entry],
    ledger: {
      ledgerId: id,
      tier: 'project',
      revision: 1,
      owner: { tier: 'project', id },
      formerOwner: null,
      runtime,
      entryCount: 1,
      nextSequence: 2,
      staleAfterDays: 90,
      sourceEquivalences: []
    }
  }
}

function deferred() {
  let resolve!: (value: LedgerResponse) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<LedgerResponse>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function Probe(options: Options): null {
  latest = useLedgerRequest(options)
  useLayoutEffect(() => {
    commits.push(latest)
  })
  return null
}

async function render(options: Options = initial): Promise<void> {
  await act(async () => {
    root.render(createElement(Probe, options))
  })
}

beforeEach(() => {
  mockedRequest.mockReset().mockResolvedValue(response('current'))
  commits = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

describe('useLedgerRequest', () => {
  it('loads local state through the captured paired host and preserves the returned owner', async () => {
    await render()
    expect(mockedRequest).toHaveBeenCalledWith(
      { operation: 'list', target: targetA, filters: {} },
      'paired-a'
    )
    expect(latest.ledger).toEqual(response('current').ledger)
    expect(latest.entries).toEqual(response('current').entries)
    expect(latest.loading).toBe(false)
    expect(latest.error).toBeNull()
  })

  it('clears old entries and summary on the first committed target change', async () => {
    await render()
    const next = deferred()
    mockedRequest.mockReturnValueOnce(next.promise)
    commits = []
    await render({ ...initial, target: targetB })
    expect(commits[0]).toMatchObject({ entries: [], ledger: null, error: null, loading: true })
    await act(async () => {
      next.resolve(response('b'))
    })
    expect(latest.entries[0].id).toBe('b')
  })

  it('discards stale success and failure responses across A-B-A selections', async () => {
    const firstA = deferred()
    const b = deferred()
    const secondA = deferred()
    mockedRequest
      .mockReturnValueOnce(firstA.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(secondA.promise)
    await render()
    await render({ ...initial, target: targetB })
    await render()
    await act(async () => {
      firstA.resolve(response('old-a'))
      b.reject(new Error('old-b'))
    })
    expect(latest).toMatchObject({ entries: [], ledger: null, loading: true, error: null })
    await act(async () => {
      secondA.resolve(response('new-a'))
    })
    expect(latest.entries[0].id).toBe('new-a')
  })

  it('keeps the newest refresh when requests for the same selection finish out of order', async () => {
    await render()
    const older = deferred()
    const newer = deferred()
    mockedRequest.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    let olderRefresh!: Promise<void>
    let newerRefresh!: Promise<void>
    act(() => {
      olderRefresh = latest.refresh()
      newerRefresh = latest.refresh()
    })
    await act(async () => {
      newer.resolve(response('newer'))
      await newerRefresh
    })
    await act(async () => {
      older.reject(new Error('obsolete'))
      await olderRefresh
    })
    expect(latest.entries[0].id).toBe('newer')
    expect(latest.error).toBeNull()
  })

  it('skips hidden loads and manual refreshes, clears hidden target changes, and catches up', async () => {
    await render()
    await render({ ...initial, isVisible: false })
    await render({ ...initial, target: targetB, isVisible: false })
    expect(latest).toMatchObject({ entries: [], ledger: null, loading: false })
    await act(async () => {
      await latest.refresh()
    })
    expect(mockedRequest).toHaveBeenCalledTimes(1)
    await render({ ...initial, target: targetB })
    expect(mockedRequest).toHaveBeenCalledTimes(2)
    expect(mockedRequest).toHaveBeenLastCalledWith(
      { operation: 'list', target: targetB, filters: {} },
      'paired-a'
    )
    await render({ ...initial, target: targetB, isVisible: false })
    await render({ ...initial, target: targetB })
    expect(mockedRequest).toHaveBeenCalledTimes(2)
  })

  it('loads once when initially hidden and does not resurrect data after a hidden A-B-A', async () => {
    await render({ ...initial, isVisible: false })
    expect(mockedRequest).not.toHaveBeenCalled()
    await render()
    await render({ ...initial, target: targetB, isVisible: false })
    await render({ ...initial, isVisible: false })
    expect(latest.entries).toEqual([])
    await render()
    expect(mockedRequest).toHaveBeenCalledTimes(2)
  })

  it('clears when there is no target and does not issue an unscoped list or mutation', async () => {
    await render()
    await render({ ...initial, target: null })
    expect(latest).toMatchObject({ entries: [], ledger: null, loading: false, error: null })
    await latest.refresh()
    await expect(latest.perform({ operation: 'file' })).rejects.toThrow('Ledger target unavailable')
    expect(mockedRequest).toHaveBeenCalledTimes(1)
  })

  it('treats a host change as a new selection and supports local or SSH routing', async () => {
    const paired = deferred()
    mockedRequest.mockReturnValueOnce(paired.promise)
    await render()
    await render({ ...initial, environmentId: undefined })
    await act(async () => {
      paired.resolve(response('stale-paired'))
    })
    expect(mockedRequest).toHaveBeenLastCalledWith(
      { operation: 'list', target: targetA, filters: {} },
      undefined
    )
    expect(latest.entries[0].id).toBe('current')
  })

  it('captures mutation ownership and prevents its completion from refreshing another selection', async () => {
    await render()
    const mutation = deferred()
    mockedRequest.mockReturnValueOnce(mutation.promise)
    let pending!: Promise<void>
    act(() => {
      pending = latest.perform({ operation: 'review', target: targetB, id: 'entry' })
    })
    expect(mockedRequest).toHaveBeenLastCalledWith(
      { operation: 'review', target: targetA, id: 'entry' },
      'paired-a'
    )
    await render({ ...initial, target: targetB, environmentId: 'paired-b' })
    await render()
    const count = mockedRequest.mock.calls.length
    await act(async () => {
      mutation.resolve(response('mutated-old-a'))
      await pending
    })
    expect(mockedRequest).toHaveBeenCalledTimes(count)
    expect(latest.entries[0].id).toBe('current')
  })

  it('refreshes the latest filters after mutation success without changing its owning host', async () => {
    await render()
    const mutation = deferred()
    mockedRequest.mockReturnValueOnce(mutation.promise)
    let pending!: Promise<void>
    act(() => {
      pending = latest.perform({ operation: 'review', id: 'entry' })
    })
    await render({ ...initial, filters: { reviewed: true } })
    mockedRequest.mockResolvedValueOnce(response('refreshed'))
    await act(async () => {
      mutation.resolve(response('mutated'))
      await pending
    })
    expect(mockedRequest).toHaveBeenLastCalledWith(
      { operation: 'list', target: targetA, filters: { reviewed: true } },
      'paired-a'
    )
    expect(latest.entries[0].id).toBe('refreshed')
  })

  it('defers mutation refresh while hidden and catches up on showing the same target', async () => {
    await render()
    const mutation = deferred()
    mockedRequest.mockReturnValueOnce(mutation.promise)
    let pending!: Promise<void>
    act(() => {
      pending = latest.perform({ operation: 'review', id: 'entry' })
    })
    await render({ ...initial, isVisible: false })
    await act(async () => {
      mutation.resolve(response('mutated'))
      await pending
    })
    expect(mockedRequest).toHaveBeenCalledTimes(2)
    await render()
    expect(mockedRequest).toHaveBeenCalledTimes(3)
  })

  it('rejects mutation errors unchanged for dialogs without replacing list error state', async () => {
    await render()
    const error = new LedgerError('conflict', 'Review the latest revision')
    mockedRequest.mockRejectedValueOnce(error)
    await act(async () => {
      await expect(latest.perform({ operation: 'review', id: 'entry' })).rejects.toBe(error)
    })
    expect(latest.error).toBeNull()
    expect(latest.entries[0].id).toBe('current')
    expect(mockedRequest).toHaveBeenCalledTimes(2)
  })

  it('keeps list failures in state, clears errors on selection change, and accepts empty ledgers', async () => {
    mockedRequest.mockRejectedValueOnce(new LedgerError('owner-ambiguous', 'Several projects'))
    await render()
    expect(latest.error).toEqual({ code: 'owner-ambiguous', message: 'Several projects' })
    const next = deferred()
    mockedRequest.mockReturnValueOnce(next.promise)
    commits = []
    await render({ ...initial, target: targetB })
    expect(commits[0].error).toBeNull()
    await act(async () => {
      next.resolve({ schemaVersion: 1, runtime, ledger: null })
    })
    expect(latest).toMatchObject({ ledger: null, entries: [], error: null, loading: false })
    mockedRequest.mockRejectedValueOnce('offline')
    await act(async () => {
      await expect(latest.refresh()).resolves.toBeUndefined()
    })
    expect(latest.error).toEqual({ message: 'offline' })
  })

  it('does not refetch for equivalent option objects', async () => {
    await render({ ...initial, filters: { state: 'open' } })
    await render({ ...initial, target: { ...targetA }, filters: { state: 'open' } })
    expect(mockedRequest).toHaveBeenCalledTimes(1)
  })

  it('discards an in-flight response after the target changes while hidden', async () => {
    const old = deferred()
    mockedRequest.mockReturnValueOnce(old.promise)
    await render()
    await render({ ...initial, target: targetB, isVisible: false })
    await act(async () => {
      old.resolve(response('old'))
    })
    expect(latest).toMatchObject({ entries: [], ledger: null, loading: false, error: null })
    expect(mockedRequest).toHaveBeenCalledTimes(1)
    await render({ ...initial, target: targetB })
    expect(latest.entries[0].id).toBe('current')
  })

  it('discards an old filter response when a new filtered list has completed', async () => {
    const old = deferred()
    mockedRequest.mockReturnValueOnce(old.promise)
    await render({ ...initial, filters: { state: 'open' } })
    await render({ ...initial, filters: { state: 'resolved' } })
    await act(async () => {
      old.resolve(response('old-filter'))
    })
    expect(latest.entries[0].id).toBe('current')
    expect(latest.error).toBeNull()
  })

  it('resolves a successful mutation even when the following list refresh fails', async () => {
    await render()
    mockedRequest
      .mockResolvedValueOnce(response('mutated'))
      .mockRejectedValueOnce(new LedgerError('workspace-missing', 'Workspace closed'))
    await act(async () => {
      await expect(latest.perform({ operation: 'review', id: 'entry' })).resolves.toBeUndefined()
    })
    expect(latest.error).toEqual({ code: 'workspace-missing', message: 'Workspace closed' })
    expect(latest.loading).toBe(false)
  })

  it('does not refresh after an unmounted mutation completes', async () => {
    await render()
    const mutation = deferred()
    mockedRequest.mockReturnValueOnce(mutation.promise)
    const pending = latest.perform({ operation: 'review', id: 'entry' })
    act(() => root.unmount())
    mutation.resolve(response('mutated'))
    await pending
    expect(mockedRequest).toHaveBeenCalledTimes(2)
  })
})
