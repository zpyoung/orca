import { describe, expect, it, vi } from 'vitest'
import { HEIMDALL_DISPATCH_RESULT_PRE_DISPATCH_FAILURE_RUNTIME_CAPABILITY } from '../../../../../shared/fork-heimdall/capability'
import { HEIMDALL_CHANNELS } from '../../../../../shared/fork-heimdall/api'
import {
  NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  RUNTIME_CAPABILITIES
} from '../../../../../shared/protocol-version'
import { remoteRuntimeClientCapabilities } from '../../../../../shared/remote-runtime-client-capabilities'
import type { WatcherListEntry } from '../../../../../shared/fork-heimdall/watcher-types'
import { eraseRpcMethods, isStreamingMethod, type RpcContext, type RpcMethod } from '../../core'
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
  const found = eraseRpcMethods(HEIMDALL_METHODS).find((candidate) => candidate.name === name)
  if (!found || isStreamingMethod(found)) {
    throw new Error(`Missing Heimdall RPC method ${name}`)
  }
  return found
}

async function call(
  runtime: object,
  name: string,
  params: unknown,
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'> = {}
): Promise<unknown> {
  const target = method(name)
  return await target.handler(target.params?.parse(params), {
    runtime: runtime as never,
    ...context
  })
}

function harness(entries: unknown[] = []) {
  const runtime = {}
  const ledger = { watcherId: 'watcher-1', entries }
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
    detail: vi.fn(async () => ({ watcher: { entry: ENTRY }, ledger, traces: [], workers: [] })),
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

  it('negotiates the expanded dispatch refusal before serving it from ledger reads', async () => {
    const result = {
      status: 'refused',
      reason: 'pre-dispatch-failure',
      detail: 'database unavailable'
    }
    const { runtime } = harness([
      {
        eventId: 'attempt-settled',
        watcherId: 'watcher-1',
        atMs: 1,
        origin: 'owner',
        class: 'fact',
        kind: 'attempt',
        attemptId: 'attempt-1',
        fingerprint: 'dispatch:failure',
        action: {
          kind: 'prepare-fix',
          capability: 'fixChecks',
          visibility: 'local',
          contentIdentity: 'head-1',
          evidenceKey: 'checks-1'
        },
        state: 'settled',
        effect: 'not-landed',
        reason: 'pre-dispatch-failure',
        result
      }
    ])
    const legacyContext = { clientKind: 'runtime' as const, clientCapabilities: [] }
    const capableContext = {
      clientKind: 'runtime' as const,
      clientCapabilities: [HEIMDALL_DISPATCH_RESULT_PRE_DISPATCH_FAILURE_RUNTIME_CAPABILITY]
    }

    const legacyLedger = (await call(
      runtime,
      LEGACY_HEIMDALL_CHANNELS.ledger,
      { watcherId: 'watcher-1' },
      legacyContext
    )) as { entries: Record<string, unknown>[] }
    const legacyDetail = (await call(
      runtime,
      HEIMDALL_CHANNELS.detail,
      { watcherId: 'watcher-1', connectionId: null, pairingRevision: null },
      legacyContext
    )) as { ledger: { entries: Record<string, unknown>[] } }
    const capableDetail = (await call(
      runtime,
      HEIMDALL_CHANNELS.detail,
      { watcherId: 'watcher-1', connectionId: null, pairingRevision: null },
      capableContext
    )) as { ledger: { entries: Record<string, unknown>[] } }

    expect(legacyLedger.entries[0]).toMatchObject({
      effect: 'not-landed',
      reason: 'pre-dispatch-failure'
    })
    expect(legacyLedger.entries[0]).not.toHaveProperty('result')
    expect(legacyDetail.ledger.entries[0]).not.toHaveProperty('result')
    expect(capableDetail.ledger.entries[0]).toHaveProperty('result', result)
    expect(RUNTIME_CAPABILITIES).toContain(
      HEIMDALL_DISPATCH_RESULT_PRE_DISPATCH_FAILURE_RUNTIME_CAPABILITY
    )
    expect(NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES).toContain(
      HEIMDALL_DISPATCH_RESULT_PRE_DISPATCH_FAILURE_RUNTIME_CAPABILITY
    )
    expect(remoteRuntimeClientCapabilities()).toContain(
      HEIMDALL_DISPATCH_RESULT_PRE_DISPATCH_FAILURE_RUNTIME_CAPABILITY
    )
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
