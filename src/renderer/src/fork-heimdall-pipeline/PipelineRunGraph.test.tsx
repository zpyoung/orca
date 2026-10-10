// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildWatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-test-fixtures'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { WatcherWorkerNavigation } from '../../../shared/fork-heimdall/fleet-types'
import { WatcherLedgerSchema } from '../../../shared/fork-heimdall/ledger-types'
import { HeimdallFleetSnapshotReaderSchema } from '../../../shared/fork-heimdall/remote-reader-schemas'
import { BUILTIN_OBJECTIVE_PIPELINE_TEXT } from '../../../shared/fork-heimdall-pipeline/builtin-pipelines'
import { makePipelineNodeEvidenceKey } from '../../../shared/fork-heimdall-pipeline/choice-types'
import { parsePipelineText } from '../../../shared/fork-heimdall-pipeline/pipeline-parse'
import {
  PipelineRunViewSchema,
  type PipelineRunNodeView,
  type PipelineRunView
} from '../../../shared/fork-heimdall-pipeline/run-view-types'
import type { WatcherFleetEntryReader } from '../../../shared/fork-heimdall/remote-reader-schemas'
import { PipelineRunGraph } from './PipelineRunGraph'

const { openWorker, resolveWorkerNavigation } = vi.hoisted(() => ({
  openWorker: vi.fn(),
  resolveWorkerNavigation: vi.fn(
    (navigation: { worktreeId: string; executionHostId: string; paneKey: string }) => navigation
  )
}))

vi.mock('@/fork-heimdall/heimdall-worker-navigation', () => ({
  openHeimdallWorker: openWorker,
  resolveHeimdallWorkerNavigation: resolveWorkerNavigation
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function rowForKind(kind: string): WatcherFleetEntryReader {
  const base = buildWatcherFleetEntry(1, 10)
  const snapshot = HeimdallFleetSnapshotReaderSchema.parse({
    entries: [
      {
        ...base,
        entry: {
          ...base.entry,
          enrollment: { ...base.entry.enrollment, kind }
        }
      }
    ],
    generatedAtMs: 10
  })
  const row = snapshot.entries[0]
  if (!row) {
    throw new Error('The reader fixture has no watcher row')
  }
  return row
}

function makeView(input: {
  document: unknown
  nodes: readonly PipelineRunNodeView[]
  edges?: readonly { from: string; to: string; when?: string }[]
  kind?: PipelineRunView['kind']
  label?: string
}): PipelineRunView {
  return PipelineRunViewSchema.parse({
    watcherId: 'watcher-1',
    kind: input.kind ?? 'pipeline',
    pin: {
      ref: input.kind === 'objective' ? 'builtin:objective' : 'repo:demo',
      scope: input.kind === 'objective' ? 'builtin' : 'repo',
      id: input.kind === 'objective' ? 'objective' : 'demo',
      contentHash: `sha256:${'1'.repeat(64)}`,
      documentVersion: 1,
      runNumber: 3,
      label: input.label ?? 'Demo v1'
    },
    document: input.document,
    nodes: input.nodes,
    edges: input.edges ?? [],
    asOfMs: 1_000
  })
}

function graphNode(input: {
  id: string
  type: string
  status: PipelineRunNodeView['status']
  label?: string
  attempt?: number
  round?: number
  turns?: number
  phase?: string
  revision?: number
  progress?: { done: number; total: number }
  waitingFor?: PipelineRunNodeView['waitingFor']
  escalationId?: string
  workerNavigation?: PipelineRunNodeView['workerNavigation']
  parentInstanceId?: string
  taskId?: string
  checks?: PipelineRunNodeView['checks']
  usage?: PipelineRunNodeView['usage']
  warnings?: PipelineRunNodeView['warnings']
}): PipelineRunNodeView {
  return {
    instanceId: input.parentInstanceId ? `${input.id}[${input.taskId}]` : input.id,
    nodeId: input.id,
    type: input.type,
    label: input.label ?? input.id,
    status: input.status,
    waitingFor: input.waitingFor ?? null,
    ...(input.escalationId === undefined ? {} : { escalationId: input.escalationId }),
    epoch: 0,
    attempt: input.attempt ?? 1,
    ...(input.round === undefined ? {} : { round: input.round }),
    elapsedMs: 120_000,
    turns: input.turns ?? 2,
    ...(input.phase === undefined ? {} : { phase: input.phase }),
    ...(input.revision === undefined ? {} : { revision: input.revision }),
    ...(input.progress === undefined ? {} : { progress: input.progress }),
    ...(input.workerNavigation === undefined ? {} : { workerNavigation: input.workerNavigation }),
    ...(input.parentInstanceId === undefined ? {} : { parentInstanceId: input.parentInstanceId }),
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.checks === undefined ? {} : { checks: input.checks }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.warnings === undefined ? {} : { warnings: input.warnings })
  }
}

function documentWith(nodes: readonly unknown[]): unknown {
  return { version: 1, id: 'demo', name: 'Demo', inputs: {}, nodes }
}

function objectiveView(): PipelineRunView {
  const parsed = parsePipelineText(BUILTIN_OBJECTIVE_PIPELINE_TEXT)
  if (!parsed.document) {
    throw new Error('The built-in Objective source is invalid')
  }
  return makeView({
    document: parsed.document,
    kind: 'objective',
    label: 'Objective v1',
    nodes: [
      graphNode({
        id: 'objective',
        type: 'objective',
        label: 'Objective v1',
        status: 'running',
        phase: 'review',
        revision: 3,
        progress: { done: 2, total: 4 },
        checks: [
          {
            name: 'Unit tests',
            result: {
              contentIdentity: 'objective-content',
              pass: true,
              exitCode: 0,
              timedOut: false,
              completedAtMs: 1_000
            }
          }
        ],
        usage: { totalTokens: 12, estimatedCostUsd: 0.5, estimate: true },
        warnings: ['Overlapping task ownership']
      })
    ]
  })
}

describe('PipelineRunGraph', () => {
  it('renders tone, elapsed time, attempt, and turn count for every run state', () => {
    const statuses: PipelineRunNodeView['status'][] = [
      'pending',
      'running',
      'waiting',
      'done',
      'failed',
      'skipped',
      'unverifiable',
      'unknown'
    ]
    const nodes = statuses.map((status) => graphNode({ id: status, type: 'check', status }))
    const view = makeView({
      document: documentWith(
        nodes.map((node) => ({ id: node.nodeId, type: 'check', command: 'true' }))
      ),
      nodes
    })

    render(<PipelineRunGraph view={view} surface="heimdall-detail" />)

    const expectedTones: Record<PipelineRunNodeView['status'], string> = {
      pending: 'neutral',
      running: 'warning',
      waiting: 'warning',
      done: 'success',
      failed: 'destructive',
      skipped: 'neutral',
      unverifiable: 'neutral',
      unknown: 'neutral'
    }

    for (const status of statuses) {
      const pill = screen.getByTestId(`pipeline-run-node-status-${status}`)
      expect(pill).toHaveAttribute('data-tone', expectedTones[status])
      expect(screen.getByTestId(`pipeline-run-node-${status}`)).toHaveTextContent('Elapsed 2m')
      expect(screen.getByTestId(`pipeline-run-node-${status}`)).toHaveTextContent('Attempt 1')
      expect(screen.getByTestId(`pipeline-run-node-${status}`)).toHaveTextContent('2 turns')
    }
    expect(screen.getByTestId('pipeline-run-graph')).toBeInTheDocument()
    expect(screen.getByText('Run time 0m')).toBeInTheDocument()
    expect(screen.getByText('Run turns 16')).toBeInTheDocument()
    expect(
      screen.getByTestId('pipeline-run-graph').querySelector('.react-flow__node-draggable')
    ).toBeNull()
  })

  it('renders future node types as labeled generic nodes with state and lays out from the pinned graph', () => {
    const view = makeView({
      document: documentWith([
        {
          id: 'first',
          type: 'teleport',
          label: 'Original teleport label',
          config: { route: 'Mars' }
        },
        { id: 'next', type: 'check', command: 'true', after: ['first'] }
      ]),
      nodes: [
        graphNode({
          id: 'first',
          type: 'teleport',
          label: 'Original teleport label',
          status: 'skipped'
        }),
        graphNode({ id: 'next', type: 'check', status: 'pending' })
      ],
      edges: [{ from: 'first', to: 'next' }]
    })

    const { container } = render(<PipelineRunGraph view={view} surface="heimdall-detail" />)

    expect(screen.getByText('Unknown node type: teleport')).toBeInTheDocument()
    expect(screen.getByText('Original teleport label')).toBeInTheDocument()
    expect(screen.getByTestId('pipeline-run-node-first')).toHaveTextContent('Skipped')
    expect(view.document.nodes[0]).toMatchObject({
      label: 'Original teleport label',
      config: { route: 'Mars' }
    })
    const firstFlowNode = container.querySelector('.react-flow__node[data-id="first"]')
    const nextFlowNode = container.querySelector('.react-flow__node[data-id="next"]')
    expect(firstFlowNode).not.toBeNull()
    expect(nextFlowNode).not.toBeNull()
    expect(firstFlowNode?.getAttribute('style')).not.toBe(nextFlowNode?.getAttribute('style'))
  })

  it('shows a second loop round in place of the ordinary attempt label', () => {
    const view = makeView({
      document: documentWith([
        { id: 'review', type: 'agent', harness: 'codex', prompt: 'Review the patch' }
      ]),
      nodes: [graphNode({ id: 'review', type: 'agent', status: 'running', round: 2 })]
    })

    render(<PipelineRunGraph view={view} surface="heimdall-detail" />)

    expect(screen.getByTestId('pipeline-run-node-review')).toHaveTextContent('Round 2')
    expect(screen.getByTestId('pipeline-run-node-review')).not.toHaveTextContent('Attempt 1')
  })

  it('opens the running agent navigation and resolves remote ownership through the existing route', () => {
    const navigation: WatcherWorkerNavigation = {
      worktreeId: 'worktree-1',
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      paneKey: 'tab-1:leaf-1'
    }
    const row = rowForKind('pipeline')
    const remoteRow = {
      ...row,
      target: { ...row.target, connectionId: 'remote-owner', pairingRevision: 7 }
    }
    const view = makeView({
      document: documentWith([
        { id: 'build', type: 'agent', harness: 'codex', prompt: 'Build the feature' }
      ]),
      nodes: [
        graphNode({ id: 'build', type: 'agent', status: 'running', workerNavigation: navigation })
      ]
    })

    render(<PipelineRunGraph view={view} surface="heimdall-detail" row={remoteRow} />)
    fireEvent.click(screen.getByTestId('pipeline-run-node-build'))

    expect(resolveWorkerNavigation).toHaveBeenCalledWith(navigation, 'remote-owner')
    expect(openWorker).toHaveBeenCalledWith(navigation)
  })

  describe('keyboard activation', () => {
    const workerNavigation: WatcherWorkerNavigation = {
      worktreeId: 'worktree-1',
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      paneKey: 'tab-1:leaf-1'
    }

    function runningAgentView(): PipelineRunView {
      return makeView({
        document: documentWith([
          { id: 'build', type: 'agent', harness: 'codex', prompt: 'Build the feature' }
        ]),
        nodes: [graphNode({ id: 'build', type: 'agent', status: 'running', workerNavigation })]
      })
    }

    it('opens the running agent worker when Enter is pressed on the focused node', () => {
      render(<PipelineRunGraph view={runningAgentView()} surface="heimdall-detail" />)

      const trigger = screen.getByTestId('pipeline-run-node-build')
      expect(trigger).toHaveAttribute('role', 'button')
      expect(trigger).not.toHaveAttribute('aria-label')
      expect(trigger).not.toHaveAttribute('aria-labelledby')
      expect(trigger).toHaveAttribute('tabindex', '0')
      trigger.focus()
      fireEvent.keyDown(trigger, { key: 'Enter' })

      expect(openWorker).toHaveBeenCalledTimes(1)
      expect(openWorker).toHaveBeenCalledWith(workerNavigation)
    })

    it('exposes the full card content as the focus stop name instead of a short label', () => {
      const view = makeView({
        document: documentWith([
          { id: 'build', type: 'agent', harness: 'codex', prompt: 'Build the feature' }
        ]),
        nodes: [
          graphNode({
            id: 'build',
            type: 'agent',
            status: 'running',
            phase: 'review',
            revision: 3,
            progress: { done: 2, total: 4 },
            workerNavigation
          })
        ]
      })
      render(<PipelineRunGraph view={view} surface="heimdall-detail" />)

      const trigger = screen.getByTestId('pipeline-run-node-build')

      expect(trigger).toHaveAttribute('role', 'button')
      expect(trigger).not.toHaveAttribute('aria-label')
      expect(trigger).not.toHaveAttribute('aria-labelledby')
      expect(trigger).toHaveTextContent('build')
      expect(trigger).toHaveTextContent('Running')
      expect(trigger).toHaveTextContent('Elapsed 2m')
      expect(trigger).toHaveTextContent('Attempt 1')
      expect(trigger).toHaveTextContent('2 turns')
      expect(trigger).toHaveTextContent('Phase: Review')
      expect(trigger).toHaveTextContent('Revision 3')
      expect(trigger).toHaveTextContent('2 of 4 tasks done')
    })

    it('opens a waiting gate when Space is pressed and keeps the page from scrolling', async () => {
      const scope = {
        actionKind: 'pipeline-pass-gate',
        contentIdentity: `pipeline:sha256:${'1'.repeat(64)}`,
        evidenceKey: makePipelineNodeEvidenceKey({
          instanceId: 'approve',
          epoch: 0,
          attempt: 1,
          cause: 'gate'
        })
      }
      const ledger = WatcherLedgerSchema.parse({
        watcherId: 'watcher-1',
        entries: [
          {
            eventId: 'event-1',
            watcherId: 'watcher-1',
            atMs: 10,
            origin: 'owner',
            class: 'fact',
            kind: 'escalation',
            escalationId: 'escalation-1',
            escalationKind: 'awaiting-approval',
            status: 'open',
            foldCount: 1,
            approvalScope: scope
          }
        ]
      })
      const view = makeView({
        document: documentWith([
          { id: 'build', type: 'agent', harness: 'codex', prompt: 'Build the feature' },
          { id: 'approve', type: 'gate', label: 'Review the result', sendBackTo: 'build' }
        ]),
        nodes: [
          graphNode({
            id: 'approve',
            type: 'gate',
            label: 'Review the result',
            status: 'waiting',
            waitingFor: 'gate',
            escalationId: 'escalation-1'
          })
        ]
      })

      render(
        <PipelineRunGraph
          view={view}
          surface="canvas-run"
          row={rowForKind('pipeline')}
          ledger={ledger}
          onAnswer={vi.fn()}
        />
      )
      const trigger = screen.getByTestId('pipeline-run-node-approve')
      expect(trigger).not.toHaveAttribute('aria-label')
      expect(trigger).not.toHaveAttribute('aria-labelledby')
      const notPrevented = fireEvent.keyDown(trigger, { key: ' ' })

      expect(notPrevented).toBe(false)
      expect(await screen.findByTestId('pipeline-gate-dialog')).toBeInTheDocument()
    })

    it('does nothing when Enter is pressed on a node with no action', () => {
      const view = makeView({
        document: documentWith([{ id: 'lint', type: 'check', command: 'true' }]),
        nodes: [graphNode({ id: 'lint', type: 'check', status: 'pending' })]
      })

      render(
        <PipelineRunGraph view={view} surface="heimdall-detail" row={rowForKind('pipeline')} />
      )
      const trigger = screen.getByTestId('pipeline-run-node-lint')

      expect(() => fireEvent.keyDown(trigger, { key: 'Enter' })).not.toThrow()
      expect(openWorker).not.toHaveBeenCalled()
      expect(screen.queryByTestId('pipeline-gate-dialog')).toBeNull()
      expect(screen.queryByTestId('pipeline-capability-approval-dialog')).toBeNull()
    })

    it('ignores key repeats, modifier combos, and other keys', () => {
      render(<PipelineRunGraph view={runningAgentView()} surface="heimdall-detail" />)
      const trigger = screen.getByTestId('pipeline-run-node-build')

      fireEvent.keyDown(trigger, { key: 'Enter', repeat: true })
      fireEvent.keyDown(trigger, { key: 'Enter', ctrlKey: true })
      fireEvent.keyDown(trigger, { key: ' ', metaKey: true })
      fireEvent.keyDown(trigger, { key: 'Enter', altKey: true })
      fireEvent.keyDown(trigger, { key: 'Enter', shiftKey: true })
      const tabNotPrevented = fireEvent.keyDown(trigger, { key: 'Tab' })

      expect(openWorker).not.toHaveBeenCalled()
      expect(tabNotPrevented).toBe(true)
    })
  })

  it('renders the pinned Swarm configuration and nests expanded children beneath it', () => {
    const view = makeView({
      document: documentWith([
        {
          id: 'swarm',
          type: 'swarm',
          label: 'Original swarm label',
          from: '$tasks.outputs.items',
          child: { harness: 'codex', prompt: 'Implement the assigned task' }
        }
      ]),
      nodes: [
        graphNode({ id: 'swarm', type: 'swarm', label: 'Original swarm label', status: 'running' }),
        graphNode({
          id: 'swarm',
          type: 'swarm',
          label: 'Task alpha',
          status: 'running',
          parentInstanceId: 'swarm',
          taskId: 'task-alpha'
        })
      ]
    })
    const { container } = render(<PipelineRunGraph view={view} surface="heimdall-detail" />)

    expect(screen.getByTestId('pipeline-run-node-swarm')).toHaveTextContent('Original swarm label')
    expect(screen.getByTestId('pipeline-run-node-swarm')).toHaveTextContent(
      'n = $tasks.outputs.items (known at run time)'
    )
    expect(screen.getByTestId('pipeline-run-node-swarm[task-alpha]')).toHaveTextContent(
      'Task alpha'
    )
    expect(screen.getByTestId('pipeline-run-node-swarm[task-alpha]')).toHaveTextContent('Agent')
    const swarmFlowNode = container.querySelector('.react-flow__node[data-id="swarm"]')
    const childFlowNode = container.querySelector('.react-flow__node[data-id="swarm[task-alpha]"]')
    expect(swarmFlowNode).not.toBeNull()
    expect(childFlowNode).not.toBeNull()
    expect(swarmFlowNode?.getAttribute('style')).not.toBe(childFlowNode?.getAttribute('style'))
  })

  it('opens and submits a waiting gate using the ledger scope and requested surface', async () => {
    const scope = {
      actionKind: 'pipeline-pass-gate',
      contentIdentity: `pipeline:sha256:${'1'.repeat(64)}`,
      evidenceKey: makePipelineNodeEvidenceKey({
        instanceId: 'approve',
        epoch: 0,
        attempt: 1,
        cause: 'gate'
      })
    }
    const ledger = WatcherLedgerSchema.parse({
      watcherId: 'watcher-1',
      entries: [
        {
          eventId: 'event-1',
          watcherId: 'watcher-1',
          atMs: 10,
          origin: 'owner',
          class: 'fact',
          kind: 'escalation',
          escalationId: 'escalation-1',
          escalationKind: 'awaiting-approval',
          status: 'open',
          foldCount: 1,
          approvalScope: scope
        }
      ]
    })
    const view = makeView({
      document: documentWith([
        { id: 'build', type: 'agent', harness: 'codex', prompt: 'Build the feature' },
        { id: 'approve', type: 'gate', label: 'Review the result', sendBackTo: 'build' }
      ]),
      nodes: [
        graphNode({
          id: 'approve',
          type: 'gate',
          label: 'Review the result',
          status: 'waiting',
          waitingFor: 'gate',
          escalationId: 'escalation-1'
        })
      ]
    })
    const row = rowForKind('pipeline')
    const onAnswer = vi.fn().mockResolvedValue({ status: 'applied', appliedAtMs: 100 })

    render(
      <PipelineRunGraph
        view={view}
        surface="canvas-run"
        row={row}
        ledger={ledger}
        onAnswer={onAnswer}
      />
    )
    fireEvent.click(screen.getByTestId('pipeline-run-node-approve'))

    expect(await screen.findByTestId('pipeline-gate-dialog')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send back' })).toBeDisabled()
    fireEvent.change(screen.getByTestId('pipeline-gate-comment'), {
      target: { value: 'split step 6' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))

    await waitFor(() =>
      expect(onAnswer).toHaveBeenCalledWith({
        kind: 'answer-pipeline-choice',
        scope,
        choice: 'approve',
        surface: 'canvas-run'
      })
    )
  })
  it('opens and approves a native Land push scope from the run graph', async () => {
    const scope = {
      actionKind: 'pipeline-land-push',
      contentIdentity: `pipeline:sha256:${'1'.repeat(64)}`,
      evidenceKey: makePipelineNodeEvidenceKey({
        instanceId: 'publish',
        epoch: 0,
        attempt: 1,
        step: JSON.stringify(['pipeline-land-push', 'main', 'origin', 'main', 'head', 'before'])
      })
    }
    const ledger = WatcherLedgerSchema.parse({
      watcherId: 'watcher-1',
      entries: [
        {
          eventId: 'land-approval',
          watcherId: 'watcher-1',
          atMs: 10,
          origin: 'owner',
          class: 'fact',
          kind: 'escalation',
          escalationId: 'land-push',
          escalationKind: 'awaiting-approval',
          status: 'open',
          foldCount: 1,
          approvalScope: scope
        }
      ]
    })
    const view = makeView({
      document: documentWith([{ id: 'publish', type: 'land' }]),
      nodes: [
        graphNode({
          id: 'publish',
          type: 'land',
          status: 'waiting',
          waitingFor: 'capability-approval',
          escalationId: 'land-push'
        })
      ]
    })
    const onApprove = vi.fn().mockResolvedValue({ status: 'applied', appliedAtMs: 100 })

    render(
      <PipelineRunGraph
        view={view}
        surface="canvas-run"
        row={rowForKind('pipeline')}
        ledger={ledger}
        onApprove={onApprove}
      />
    )
    fireEvent.click(screen.getByTestId('pipeline-run-node-publish'))

    expect(await screen.findByTestId('pipeline-capability-approval-dialog')).toBeInTheDocument()
    expect(screen.getByText('pipeline-land-push')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Approve action' }))

    await waitFor(() => expect(onApprove).toHaveBeenCalledWith(scope))
  })

  it('shows objective composite phase, revision, and task progress on the card face', () => {
    const view = objectiveView()

    render(<PipelineRunGraph view={view} surface="heimdall-detail" row={rowForKind('objective')} />)

    const card = screen.getByTestId('pipeline-run-node-objective')
    expect(card).toHaveTextContent('Phase: Review')
    expect(card).toHaveTextContent('Revision 3')
    expect(card).toHaveTextContent('2 of 4 tasks done')
    // react flow leaves unmeasured nodes visibility:hidden in happy-dom, so the role query needs hidden
    expect(within(card).getByRole('progressbar', { hidden: true })).toHaveAttribute(
      'aria-valuenow',
      '50'
    )
    expect(card).not.toHaveTextContent('Unit tests')
    expect(card).not.toHaveTextContent('Overlapping task ownership')
  })

  it('moves Checks results, warnings and the usage estimate into a hover card that opens on focus', async () => {
    const view = objectiveView()

    render(<PipelineRunGraph view={view} surface="heimdall-detail" row={rowForKind('objective')} />)

    expect(screen.queryByText('Unit tests')).toBeNull()
    const trigger = screen.getByTestId('pipeline-run-node-objective')
    expect(trigger).toHaveAttribute('tabindex', '0')
    fireEvent.focus(trigger)

    expect(await screen.findByText('Unit tests')).toBeInTheDocument()
    const detail = (await screen.findByText('Unit tests')).closest(
      '[data-slot="hover-card-content"]'
    )
    expect(detail).not.toBeNull()
    expect(detail).toHaveTextContent('"pass": true')
    expect(detail).toHaveTextContent('Estimate')
    expect(detail).toHaveTextContent('12 tokens')
    expect(detail).toHaveTextContent('0.50 estimated')
    expect(detail).toHaveTextContent('Overlapping task ownership')
    expect(detail).toHaveTextContent('Objective v1')
    expect(detail).toHaveTextContent('Node ID')
    expect(detail).toHaveTextContent('Instance ID')
  })

  it('renders one card frame per run node carrying its visual state and no second status box', () => {
    const view = makeView({
      document: documentWith([
        { id: 'build', type: 'agent', harness: 'codex', prompt: 'Build the feature' },
        { id: 'approve', type: 'gate', label: 'Review the result', sendBackTo: 'build' },
        { id: 'broken', type: 'teleport' }
      ]),
      nodes: [
        graphNode({ id: 'build', type: 'agent', status: 'running' }),
        graphNode({
          id: 'approve',
          type: 'gate',
          label: 'Review the result',
          status: 'waiting',
          waitingFor: 'gate'
        }),
        graphNode({ id: 'broken', type: 'teleport', status: 'failed' })
      ]
    })

    render(<PipelineRunGraph view={view} surface="heimdall-detail" />)

    const expected = { build: 'running', approve: 'needs-you', broken: 'failed' }
    for (const [id, state] of Object.entries(expected)) {
      const card = screen.getByTestId(`pipeline-run-node-${id}`)
      expect(card).toHaveAttribute('data-node-instance', id)
      const frames = card.querySelectorAll('[data-node-type]')
      expect(frames).toHaveLength(1)
      expect(frames[0]).toHaveAttribute('data-visual-state', state)
      expect(card.querySelectorAll(`[data-testid="pipeline-run-node-status-${id}"]`)).toHaveLength(
        1
      )
    }
    expect(screen.getByTestId('pipeline-run-node-status-approve')).toHaveAttribute(
      'data-tone',
      'warning'
    )
    expect(screen.getByTestId('pipeline-run-node-status-broken')).toHaveTextContent('Failed')
  })
})
