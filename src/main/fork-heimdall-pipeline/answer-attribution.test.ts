import * as os from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HEIMDALL_CHANNELS } from '../../shared/fork-heimdall/api'
import { getLatestEscalations } from '../../shared/fork-heimdall/ledger-queries'
import type { EvidenceEntry } from '../../shared/fork-heimdall/ledger-types'
import type {
  WatcherCommandRequest,
  WatcherCommandResult
} from '../../shared/fork-heimdall/fleet-types'
import type { HeimdallFleetSnapshotReader } from '../../shared/fork-heimdall/remote-reader-schemas'
import { PIPELINE_ANSWER_EVIDENCE_KIND } from '../../shared/fork-heimdall-pipeline/choice-types'
import { DESKTOP_RENDERER_CLIENT_ID } from '../runtime/rpc/methods/fork-artifact-passwords/artifact-password-local-caller'
import { eraseRpcMethods, isStreamingMethod } from '../runtime/rpc/core'
import type { RpcContext, RpcMethod } from '../runtime/rpc/core'
import { bindHeimdallTransport } from '../runtime/rpc/methods/fork-heimdall/kernel-binding'
import { HEIMDALL_METHODS } from '../runtime/rpc/methods/fork-heimdall/heimdall'
import { HeimdallFleetTransport } from '../fork-heimdall/fleet-transport'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../ipc/desktop-renderer-runtime-capabilities'
import {
  createPipelineKindTestHarness,
  PIPELINE_GATE_SOURCE,
  type PipelineKindTestHarness
} from './pipeline-kind-test-harness'

vi.mock('electron', () => ({}))

type RpcCaller = Pick<RpcContext, 'clientKind' | 'clientId' | 'clientCapabilities'>
type PipelineAnswerCommand = Extract<
  WatcherCommandRequest['command'],
  { kind: 'answer-pipeline-choice' }
>
type GateWatcher = {
  watcherId: string
  target: WatcherCommandRequest['target']
  expectedOwner: WatcherCommandRequest['expectedOwner']
  scope: PipelineAnswerCommand['scope']
}

const DESKTOP_CALLER: RpcCaller = {
  clientKind: 'runtime',
  clientId: DESKTOP_RENDERER_CLIENT_ID,
  clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
}
const OLD_RUNTIME_CALLER: RpcCaller = {
  clientKind: 'runtime',
  clientId: 'a'.repeat(48),
  clientCapabilities: []
}

const MOBILE_CALLER: RpcCaller = {
  clientKind: 'mobile',
  clientId: 'b'.repeat(48),
  clientCapabilities: []
}

const harnesses: PipelineKindTestHarness[] = []
const transports: HeimdallFleetTransport[] = []

afterEach(async () => {
  for (const transport of transports.splice(0)) {
    transport.dispose()
  }
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()))
})

async function createHarness(): Promise<PipelineKindTestHarness> {
  const harness = await createPipelineKindTestHarness()
  const transport = new HeimdallFleetTransport({
    kernel: harness.service,
    userDataPath: () => harness.profile,
    store: harness.store
  })
  bindHeimdallTransport(harness.runtime, transport)
  harnesses.push(harness)
  transports.push(transport)
  return harness
}

function method(name: string): RpcMethod {
  const found = eraseRpcMethods(HEIMDALL_METHODS).find((candidate) => candidate.name === name)
  if (!found || isStreamingMethod(found)) {
    throw new Error(`Missing Heimdall RPC method ${name}`)
  }
  return found
}

async function call<TResult>(
  harness: PipelineKindTestHarness,
  name: string,
  params: unknown,
  caller: RpcCaller = {}
): Promise<TResult> {
  const target = method(name)
  const result = await target.handler(target.params?.parse(params), {
    runtime: harness.runtime,
    ...caller
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: RPC handlers return unknown by design; callers assert the response shape their request produces.
  return result as TResult
}

async function createGateWatcher(harness: PipelineKindTestHarness): Promise<GateWatcher> {
  const enrolled = await harness.enroll(PIPELINE_GATE_SOURCE)
  if (enrolled.status !== 'enrolled') {
    throw new Error(`Expected a new pipeline enrollment, got ${enrolled.status}`)
  }
  const watcherId = enrolled.entry.enrollment.watcherId
  await harness.tick(watcherId)

  const row = (await harness.service.fleet()).entries.find(
    (candidate) => candidate.target.watcherId === watcherId
  )
  const pending = getLatestEscalations(harness.service.ledger(watcherId)).findLast(
    (entry) => entry.escalationKind === 'awaiting-approval'
  )
  if (row === undefined || pending?.approvalScope === undefined) {
    throw new Error('Expected an active pipeline approval gate')
  }
  return {
    watcherId,
    target: row.target,
    expectedOwner: row.ownerFence,
    scope: pending.approvalScope
  }
}

function answerRequest(
  gate: GateWatcher,
  options: {
    surface?: PipelineAnswerCommand['surface']
    attribution?: PipelineAnswerCommand['attribution']
  } = {}
): WatcherCommandRequest {
  return {
    target: gate.target,
    expectedOwner: gate.expectedOwner,
    command: {
      kind: 'answer-pipeline-choice',
      scope: gate.scope,
      choice: 'approve',
      ...(options.surface === undefined ? {} : { surface: options.surface }),
      ...(options.attribution === undefined ? {} : { attribution: options.attribution })
    }
  }
}

function answerEvidence(
  harness: PipelineKindTestHarness,
  watcherId: string
): EvidenceEntry | undefined {
  return harness.service
    .ledger(watcherId)
    .entries.findLast(
      (entry): entry is EvidenceEntry =>
        entry.kind === 'evidence' && entry.evidenceKind === PIPELINE_ANSWER_EVIDENCE_KIND
    )
}

describe('pipeline answer attribution over the Heimdall RPC boundary', () => {
  it('exposes an active pipeline gate to the desktop renderer but not an older runtime client', async () => {
    const harness = await createHarness()
    await createGateWatcher(harness)

    const desktopSnapshot = await call<HeimdallFleetSnapshotReader>(
      harness,
      HEIMDALL_CHANNELS.fleet,
      {},
      DESKTOP_CALLER
    )
    const oldRuntimeSnapshot = await call<HeimdallFleetSnapshotReader>(
      harness,
      HEIMDALL_CHANNELS.fleet,
      {},
      OLD_RUNTIME_CALLER
    )

    expect(desktopSnapshot.entries.map((entry) => entry.entry.enrollment.kind)).toContain(
      'pipeline'
    )
    expect(
      desktopSnapshot.entries.find((entry) => entry.entry.enrollment.kind === 'pipeline')?.entry
        .status
    ).toMatchObject({ state: 'held', phase: 'gate' })
    expect(oldRuntimeSnapshot.entries).toEqual([])
  })

  it('audits desktop and first-hop answers and leaves forwarded runtimes unstamped', async () => {
    const desktopHarness = await createHarness()
    const desktopGate = await createGateWatcher(desktopHarness)

    await expect(
      call<WatcherCommandResult>(
        desktopHarness,
        HEIMDALL_CHANNELS.command,
        answerRequest(desktopGate, { surface: 'canvas-run' }),
        DESKTOP_CALLER
      )
    ).resolves.toMatchObject({ status: 'applied' })
    expect(answerEvidence(desktopHarness, desktopGate.watcherId)).toMatchObject({
      payload: {
        choice: 'approve',
        attribution: {
          actor: { user: os.userInfo().username, host: os.hostname() },
          surface: 'canvas-run',
          atMs: expect.any(Number)
        }
      }
    })

    const mobileHarness = await createHarness()
    const mobileGate = await createGateWatcher(mobileHarness)
    await expect(
      call<WatcherCommandResult>(
        mobileHarness,
        HEIMDALL_CHANNELS.command,
        answerRequest(mobileGate, { surface: 'canvas-run' }),
        MOBILE_CALLER
      )
    ).resolves.toMatchObject({ status: 'applied' })
    expect(answerEvidence(mobileHarness, mobileGate.watcherId)).toMatchObject({
      payload: {
        attribution: {
          actor: { user: os.userInfo().username, host: os.hostname() },
          surface: 'canvas-run',
          atMs: expect.any(Number)
        }
      }
    })

    const forwardedHarness = await createHarness()
    const forwardedGate = await createGateWatcher(forwardedHarness)
    const ledgerBefore = forwardedHarness.service.ledger(forwardedGate.watcherId)
    await expect(
      call<WatcherCommandResult>(
        forwardedHarness,
        HEIMDALL_CHANNELS.command,
        answerRequest(forwardedGate, { surface: 'canvas-run' }),
        OLD_RUNTIME_CALLER
      )
    ).resolves.toMatchObject({
      status: 'refused',
      reason: 'invalid-command',
      detail: 'A pipeline choice answer requires attribution'
    })
    expect(forwardedHarness.service.ledger(forwardedGate.watcherId)).toEqual(ledgerBefore)
    expect(answerEvidence(forwardedHarness, forwardedGate.watcherId)).toBeUndefined()
  })
})
