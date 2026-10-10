import { describe, expect, it } from 'vitest'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { WatcherWorkerNavigation } from '../../../shared/fork-heimdall/fleet-types'
import { getLatestEscalations } from '../../../shared/fork-heimdall/ledger-queries'
import {
  WatcherLedgerSchema,
  type ApprovalScope,
  type WatcherLedger
} from '../../../shared/fork-heimdall/ledger-types'
import { makePipelineNodeEvidenceKey } from '../../../shared/fork-heimdall-pipeline/choice-types'
import type { PipelineRunNodeView } from '../../../shared/fork-heimdall-pipeline/run-view-types'
import { pinnedRunView, pipelineRunRow } from './pipeline-canvas-run-fixtures'
import {
  pipelineRunNodeControl,
  pipelineRunNodeOpensWorker,
  type PipelineRunNodeControl
} from './pipeline-run-node-actions'

const WATCHER_ID = 'watcher-12'
const ESCALATION_ID = 'escalation-1'
const view = pinnedRunView(WATCHER_ID, 12)
const contentIdentity = `pipeline:${view.pin.contentHash}`

type ControlInput = Parameters<typeof pipelineRunNodeControl>[0]

function gateNode(overrides: Partial<PipelineRunNodeView> = {}): PipelineRunNodeView {
  return {
    instanceId: 'approve',
    nodeId: 'approve',
    type: 'gate',
    label: 'Review run 12',
    status: 'waiting',
    waitingFor: 'gate',
    escalationId: ESCALATION_ID,
    epoch: 0,
    attempt: 1,
    turns: 0,
    ...overrides
  }
}

function scopeFor(
  actionKind: string,
  overrides: Partial<ApprovalScope> & { cause?: 'gate' | 'retries-exhausted' } = {}
): ApprovalScope {
  const { cause, ...scopeOverrides } = overrides
  return {
    actionKind,
    contentIdentity,
    evidenceKey: makePipelineNodeEvidenceKey({
      instanceId: 'approve',
      epoch: 0,
      attempt: 1,
      ...(cause === undefined ? {} : { cause })
    }),
    ...scopeOverrides
  }
}

function escalationEntry(input: {
  scope?: ApprovalScope
  status?: 'open' | 'acknowledged' | 'resolved' | 'escalated'
  escalationKind?: string
  escalationId?: string
}): Record<string, unknown> {
  return {
    eventId: `event-${input.escalationId ?? ESCALATION_ID}`,
    watcherId: WATCHER_ID,
    atMs: 10,
    origin: 'owner',
    class: 'fact',
    kind: 'escalation',
    escalationId: input.escalationId ?? ESCALATION_ID,
    escalationKind: input.escalationKind ?? 'awaiting-approval',
    status: input.status ?? 'open',
    foldCount: 1,
    ...(input.scope === undefined ? {} : { approvalScope: input.scope })
  }
}

function approvalEntry(scope: ApprovalScope): Record<string, unknown> {
  return {
    eventId: 'approval-1',
    watcherId: WATCHER_ID,
    atMs: 20,
    origin: 'owner',
    class: 'fact',
    kind: 'approval',
    scope,
    decision: 'approved',
    foldCount: 1
  }
}

function ledgerOf(entries: readonly unknown[]): WatcherLedger {
  return WatcherLedgerSchema.parse({ watcherId: WATCHER_ID, entries })
}

function inputWithLedger(
  runNode: PipelineRunNodeView,
  ledger: WatcherLedger | null | undefined,
  overrides: Partial<ControlInput> = {}
): ControlInput {
  return {
    runNode,
    view,
    row: pipelineRunRow(WATCHER_ID, 12),
    ledger,
    latestEscalations: ledger ? getLatestEscalations(ledger) : [],
    isUnknownWatcher: false,
    ...overrides
  }
}

function inputFor(
  runNode: PipelineRunNodeView,
  scope: ApprovalScope,
  overrides: Partial<ControlInput> = {}
): ControlInput {
  return inputWithLedger(runNode, ledgerOf([escalationEntry({ scope })]), overrides)
}

function gateInput(overrides: Partial<ControlInput> = {}): ControlInput {
  return inputFor(gateNode(), scopeFor('pipeline-pass-gate', { cause: 'gate' }), overrides)
}

describe('pipelineRunNodeControl', () => {
  it('offers a choice control for a waiting gate with a matching open escalation', () => {
    const scope = scopeFor('pipeline-pass-gate', { cause: 'gate' })
    const runNode = gateNode()

    expect(pipelineRunNodeControl(inputFor(runNode, scope))).toEqual({
      node: runNode,
      scope,
      kind: 'choice'
    } satisfies PipelineRunNodeControl)
  })

  it('offers a choice control for a waiting choice node answered through pipeline-apply-choice', () => {
    const scope = scopeFor('pipeline-apply-choice', { cause: 'retries-exhausted' })
    const runNode = gateNode({ waitingFor: 'choice' })

    expect(pipelineRunNodeControl(inputFor(runNode, scope))).toEqual({
      node: runNode,
      scope,
      kind: 'choice'
    })
  })

  it('offers a capability control for a native approval scope', () => {
    const scope = scopeFor('pipeline-land-push')
    const runNode = gateNode({ waitingFor: 'capability-approval', type: 'land' })

    expect(pipelineRunNodeControl(inputFor(runNode, scope))).toEqual({
      node: runNode,
      scope,
      kind: 'capability'
    })
  })

  it('accepts an escalated awaiting-approval escalation as well as an open one', () => {
    const scope = scopeFor('pipeline-pass-gate', { cause: 'gate' })
    const ledger = ledgerOf([escalationEntry({ scope, status: 'escalated' })])

    expect(pipelineRunNodeControl(inputWithLedger(gateNode(), ledger))).toMatchObject({
      kind: 'choice'
    })
  })

  it.each([null, undefined, 'owner' as const])(
    'offers no control while waitingFor is %s',
    (value) => {
      const input = gateInput({ runNode: gateNode({ waitingFor: value }) })

      expect(pipelineRunNodeControl(input)).toBeNull()
    }
  )

  it('offers no control for an unknown watcher', () => {
    expect(pipelineRunNodeControl(gateInput({ isUnknownWatcher: true }))).toBeNull()
  })

  it('offers no control without a fleet row', () => {
    expect(pipelineRunNodeControl(gateInput({ row: undefined }))).toBeNull()
  })

  it('offers no control for a node type outside the pipeline vocabulary', () => {
    expect(
      pipelineRunNodeControl(gateInput({ runNode: gateNode({ type: 'teleport' }) }))
    ).toBeNull()
  })

  it('offers no control when the node carries no escalation id', () => {
    const { escalationId: _escalationId, ...withoutEscalation } = gateNode()

    expect(pipelineRunNodeControl(gateInput({ runNode: withoutEscalation }))).toBeNull()
  })

  it('offers no control when the escalation id matches no ledger escalation', () => {
    const input = gateInput({ runNode: gateNode({ escalationId: 'escalation-other' }) })

    expect(pipelineRunNodeControl(input)).toBeNull()
  })

  it.each(['acknowledged', 'resolved'] as const)(
    'offers no control for a %s escalation',
    (status) => {
      const scope = scopeFor('pipeline-pass-gate', { cause: 'gate' })
      const ledger = ledgerOf([escalationEntry({ scope, status })])

      expect(pipelineRunNodeControl(inputWithLedger(gateNode(), ledger))).toBeNull()
    }
  )

  it('offers no control for an escalation that is not awaiting approval', () => {
    const scope = scopeFor('pipeline-pass-gate', { cause: 'gate' })
    const ledger = ledgerOf([escalationEntry({ scope, escalationKind: 'worker-stuck' })])

    expect(pipelineRunNodeControl(inputWithLedger(gateNode(), ledger))).toBeNull()
  })

  it('offers no control for an escalation without an approval scope', () => {
    const ledger = ledgerOf([escalationEntry({})])

    expect(pipelineRunNodeControl(inputWithLedger(gateNode(), ledger))).toBeNull()
  })

  it('judges only the latest revision of an escalation', () => {
    const scope = scopeFor('pipeline-pass-gate', { cause: 'gate' })
    const ledger = ledgerOf([
      escalationEntry({ scope }),
      { ...escalationEntry({ scope, status: 'resolved' }), eventId: 'event-resolved' }
    ])

    expect(pipelineRunNodeControl(inputWithLedger(gateNode(), ledger))).toBeNull()
  })

  it.each([null, undefined])('offers no control when the ledger is %s', (ledger) => {
    const scope = scopeFor('pipeline-pass-gate', { cause: 'gate' })
    const latestEscalations = getLatestEscalations(ledgerOf([escalationEntry({ scope })]))

    expect(
      pipelineRunNodeControl(inputWithLedger(gateNode(), ledger, { latestEscalations }))
    ).toBeNull()
  })

  it('offers no control once the scope already has an approval', () => {
    const scope = scopeFor('pipeline-pass-gate', { cause: 'gate' })
    const ledger = ledgerOf([escalationEntry({ scope }), approvalEntry(scope)])

    expect(pipelineRunNodeControl(inputWithLedger(gateNode(), ledger))).toBeNull()
  })

  it('offers no control when the scope was issued for different pipeline content', () => {
    const scope = scopeFor('pipeline-pass-gate', {
      cause: 'gate',
      contentIdentity: `pipeline:sha256:${'2'.repeat(64)}`
    })

    expect(pipelineRunNodeControl(inputFor(gateNode(), scope))).toBeNull()
  })

  it.each([
    ['instance', { instanceId: 'other-gate' }],
    ['epoch', { epoch: 1 }],
    ['attempt', { attempt: 2 }]
  ] as const)('offers no control when the evidence key names a different %s', (_label, change) => {
    const scope = scopeFor('pipeline-pass-gate', { cause: 'gate' })
    const runNode = gateNode(change)

    expect(pipelineRunNodeControl(inputFor(runNode, scope))).toBeNull()
  })

  it('offers no control when the evidence key is not a node key', () => {
    const scope = scopeFor('pipeline-pass-gate', { evidenceKey: 'not-a-node-key' })

    expect(pipelineRunNodeControl(inputFor(gateNode(), scope))).toBeNull()
  })

  it('refuses a gate wait answered by a scope that is not pipeline-pass-gate', () => {
    const scope = scopeFor('pipeline-apply-choice', { cause: 'gate' })

    expect(pipelineRunNodeControl(inputFor(gateNode(), scope))).toBeNull()
  })

  it('refuses a choice wait answered by a scope that is not pipeline-apply-choice', () => {
    const scope = scopeFor('pipeline-pass-gate', { cause: 'retries-exhausted' })

    expect(pipelineRunNodeControl(inputFor(gateNode({ waitingFor: 'choice' }), scope))).toBeNull()
  })

  it('refuses a choice control when the node exposes no choices', () => {
    const scope = scopeFor('pipeline-pass-gate', { cause: 'retries-exhausted' })

    expect(pipelineRunNodeControl(inputFor(gateNode(), scope))).toBeNull()
  })

  it('refuses a choice control when the pinned document does not contain the node', () => {
    const runNode = gateNode({ instanceId: 'ghost', nodeId: 'ghost' })
    const scope = scopeFor('pipeline-pass-gate', {
      cause: 'gate',
      evidenceKey: makePipelineNodeEvidenceKey({
        instanceId: 'ghost',
        epoch: 0,
        attempt: 1,
        cause: 'gate'
      })
    })

    expect(pipelineRunNodeControl(inputFor(runNode, scope))).toBeNull()
  })

  it.each(['pipeline-pass-gate', 'pipeline-apply-choice'])(
    'refuses a capability control for the %s scope',
    (actionKind) => {
      const scope = scopeFor(actionKind, { cause: 'gate' })
      const runNode = gateNode({ waitingFor: 'capability-approval' })

      expect(pipelineRunNodeControl(inputFor(runNode, scope))).toBeNull()
    }
  )
})

describe('pipelineRunNodeOpensWorker', () => {
  const navigation: WatcherWorkerNavigation = {
    worktreeId: 'worktree-1',
    executionHostId: LOCAL_EXECUTION_HOST_ID,
    paneKey: 'tab-1:leaf-1'
  }
  const agentSource = { id: 'build', type: 'agent' }
  const swarmSource = { id: 'workers', type: 'swarm' }

  function workerNode(overrides: Partial<PipelineRunNodeView> = {}): PipelineRunNodeView {
    return {
      instanceId: 'build',
      nodeId: 'build',
      type: 'agent',
      label: 'Build',
      status: 'running',
      epoch: 0,
      attempt: 1,
      turns: 1,
      workerNavigation: navigation,
      ...overrides
    }
  }

  it('opens a running agent node that has a worker', () => {
    expect(
      pipelineRunNodeOpensWorker({
        runNode: workerNode(),
        sourceNode: agentSource,
        isUnknownWatcher: false
      })
    ).toBe(true)
  })

  it('opens a running swarm child but not the swarm parent', () => {
    const child = workerNode({
      instanceId: 'workers[alpha]',
      nodeId: 'workers',
      type: 'swarm',
      parentInstanceId: 'workers',
      taskId: 'alpha'
    })

    expect(
      pipelineRunNodeOpensWorker({
        runNode: child,
        sourceNode: swarmSource,
        isUnknownWatcher: false
      })
    ).toBe(true)
    expect(
      pipelineRunNodeOpensWorker({
        runNode: workerNode({ nodeId: 'workers', type: 'swarm' }),
        sourceNode: swarmSource,
        isUnknownWatcher: false
      })
    ).toBe(false)
  })

  it('does not open a node whose document type is not an agent', () => {
    expect(
      pipelineRunNodeOpensWorker({
        runNode: workerNode(),
        sourceNode: { id: 'build', type: 'check' },
        isUnknownWatcher: false
      })
    ).toBe(false)
  })

  it('does not open a node with no document source', () => {
    expect(
      pipelineRunNodeOpensWorker({
        runNode: workerNode(),
        sourceNode: null,
        isUnknownWatcher: false
      })
    ).toBe(false)
  })

  it.each(['pending', 'waiting', 'done', 'failed', 'skipped', 'unverifiable', 'unknown'] as const)(
    'does not open a %s agent node',
    (status) => {
      expect(
        pipelineRunNodeOpensWorker({
          runNode: workerNode({ status }),
          sourceNode: agentSource,
          isUnknownWatcher: false
        })
      ).toBe(false)
    }
  )

  it('does not open a running agent node without worker navigation', () => {
    const { workerNavigation: _workerNavigation, ...withoutNavigation } = workerNode()

    expect(
      pipelineRunNodeOpensWorker({
        runNode: withoutNavigation,
        sourceNode: agentSource,
        isUnknownWatcher: false
      })
    ).toBe(false)
  })

  it('does not open a worker for an unknown watcher', () => {
    expect(
      pipelineRunNodeOpensWorker({
        runNode: workerNode(),
        sourceNode: agentSource,
        isUnknownWatcher: true
      })
    ).toBe(false)
  })
})
