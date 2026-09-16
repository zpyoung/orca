import { describe, expect, it, vi } from 'vitest'
import type { WatcherListEntry } from '../../../../../shared/fork-heimdall/watcher-types'
import { isStreamingMethod, type RpcMethod } from '../../core'
import { HEIMDALL_METHODS } from './heimdall'
import { bindHeimdallKernel } from './kernel-binding'
import { LEGACY_HEIMDALL_CHANNELS } from './legacy-wire'

const INPUT = {
  kind: 'hosted-review' as const,
  repoId: 'repo-1',
  worktreeId: 'worktree-1',
  capabilities: { merge: 'gated' as const },
  budget: { wallClockActiveMs: 60_000, turns: 4 },
  kindPayload: {}
}
const ENTRY = {
  name: 'Watcher one',
  enrollment: {
    watcherId: 'watcher-1',
    enabled: true,
    paused: false,
    commandRevision: 7
  },
  status: { state: 'watching' }
} as unknown as WatcherListEntry

function method(name: string): RpcMethod {
  const found = HEIMDALL_METHODS.find((candidate) => candidate.name === name)
  if (!found || isStreamingMethod(found)) {
    throw new Error(`Missing Heimdall RPC method ${name}`)
  }
  return found
}

async function call(runtime: object, name: string, params: unknown): Promise<unknown> {
  const target = method(name)
  return await target.handler(target.params?.parse(params), { runtime: runtime as never })
}

function harness() {
  const runtime = {}
  const ledger = { watcherId: 'watcher-1', entries: [] }
  const debugReport = {
    schemaVersion: 2,
    enrollment: ENTRY.enrollment,
    status: ENTRY.status,
    ledger: { totalEntries: 0, entries: [] },
    traces: []
  }
  const kernel = {
    enroll: vi.fn(async () => ({ status: 'enrolled' as const, entry: ENTRY })),
    list: vi.fn(async () => [ENTRY]),
    ledger: vi.fn(() => ledger),
    debugReport: vi.fn(async () => debugReport),
    disarm: vi.fn(),
    disarmAll: vi.fn(),
    approve: vi.fn()
  }
  bindHeimdallKernel(runtime, kernel as never)
  return { runtime, kernel, ledger }
}

describe('Heimdall Phase 1 wire compatibility', () => {
  it('keeps legacy reads and raw enrollment while stripping new strict enrollment fields', async () => {
    const { runtime, ledger } = harness()

    const listed = (await call(runtime, LEGACY_HEIMDALL_CHANNELS.list, {})) as WatcherListEntry[]
    const enrolled = (await call(runtime, LEGACY_HEIMDALL_CHANNELS.enroll, INPUT)) as {
      entry: WatcherListEntry
    }
    const report = (await call(runtime, LEGACY_HEIMDALL_CHANNELS.debugReport, {
      watcherId: 'watcher-1'
    })) as { enrollment: Record<string, unknown> }

    expect(listed[0]?.enrollment).toEqual({ watcherId: 'watcher-1', enabled: true })
    expect(enrolled.entry.enrollment).toEqual({ watcherId: 'watcher-1', enabled: true })
    expect(report.enrollment).toEqual({ watcherId: 'watcher-1', enabled: true })
    await expect(
      call(runtime, LEGACY_HEIMDALL_CHANNELS.ledger, { watcherId: 'watcher-1' })
    ).resolves.toBe(ledger)
  })

  it('refuses every unfenced legacy mutation without invoking the old mutation helpers', async () => {
    const { runtime, kernel } = harness()
    const calls: [string, unknown][] = [
      [LEGACY_HEIMDALL_CHANNELS.disarm, { watcherId: 'watcher-1' }],
      [LEGACY_HEIMDALL_CHANNELS.disarmAll, {}],
      [
        LEGACY_HEIMDALL_CHANNELS.approve,
        {
          watcherId: 'watcher-1',
          scope: { actionKind: 'merge', contentIdentity: 'head-1', evidenceKey: 'checks-1' }
        }
      ]
    ]

    for (const [name, params] of calls) {
      await expect(call(runtime, name, params)).rejects.toMatchObject({
        code: 'owner-conflict',
        reason: 'fencing-required'
      })
    }
    expect(kernel.disarm).not.toHaveBeenCalled()
    expect(kernel.disarmAll).not.toHaveBeenCalled()
    expect(kernel.approve).not.toHaveBeenCalled()
  })
})
