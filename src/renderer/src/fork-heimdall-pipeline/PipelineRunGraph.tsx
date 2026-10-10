import { Background, ReactFlow, ReactFlowProvider, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { useMemo, useState } from 'react'
import {
  openHeimdallWorker,
  resolveHeimdallWorkerNavigation
} from '@/fork-heimdall/heimdall-worker-navigation'
import { formatHeimdallDuration } from '@/fork-heimdall/fleet-format'
import { translate } from '@/i18n/i18n'
import {
  PipelineNodeSchema,
  type PipelineDocument,
  type PipelineNode
} from '../../../shared/fork-heimdall-pipeline/document-schema'
import {
  getLatestApproval,
  getLatestEscalations,
  sameApprovalScope
} from '../../../shared/fork-heimdall/ledger-queries'
import type { WatcherCommandResult } from '../../../shared/fork-heimdall/fleet-types'
import type { ApprovalScope, WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherFleetEntryReader } from '../../../shared/fork-heimdall/remote-reader-schemas'
import type {
  PipelineRunNodeView,
  PipelineRunView
} from '../../../shared/fork-heimdall-pipeline/run-view-types'
import { CapabilityApprovalDialog } from './CapabilityApprovalDialog'
import { buildRunFlowEdges, pipelineEdgeTypes } from './PipelineFlowEdge'
import {
  copyNodeIdMenuItem,
  PipelineNodeContextMenu,
  type PipelineNodeContextMenuItem
} from './PipelineNodeContextMenu'
import { RunGraphNode, type PipelineRunGraphNode } from './PipelineRunGraphNode'
import { layeredLayout } from './layered-layout'
import { PipelineGateDialog, type PipelineChoiceCommand } from './PipelineGateDialog'
import {
  pipelineRunNodeControl,
  pipelineRunNodeOpensWorker,
  type PipelineRunNodeControl
} from './pipeline-run-node-actions'
import './pipeline-canvas.css'

function displayNode(
  sourceNode: PipelineRunView['document']['nodes'][number] | null,
  runNode: PipelineRunNodeView
): PipelineNode | null {
  if (!sourceNode) {
    return null
  }
  const parsed = PipelineNodeSchema.safeParse(sourceNode)
  if (!parsed.success) {
    return null
  }
  const pinnedNode: PipelineNode =
    parsed.data.label === runNode.label ? parsed.data : { ...parsed.data, label: runNode.label }
  if (runNode.parentInstanceId && pinnedNode.type === 'swarm') {
    const taskNode = PipelineNodeSchema.safeParse({
      id: pinnedNode.id,
      type: 'agent',
      label: runNode.label,
      ...pinnedNode.child
    })
    return taskNode.success ? taskNode.data : null
  }
  return pinnedNode
}

function flowPositions(
  view: PipelineRunView,
  document: PipelineDocument
): ReadonlyMap<string, { x: number; y: number }> {
  const baseLayout = layeredLayout(document)
  const positions = new Map<string, { x: number; y: number }>()
  const occupied = new Set<string>()
  for (let index = 0; index < view.nodes.length; index += 1) {
    const runNode = view.nodes[index]
    if (!runNode || runNode.parentInstanceId) {
      continue
    }
    const position = { ...(baseLayout.nodes[runNode.nodeId] ?? { x: index * 280, y: 0 }) }
    while (occupied.has(`${position.x}:${position.y}`)) {
      position.x += 280
    }
    occupied.add(`${position.x}:${position.y}`)
    positions.set(runNode.instanceId, position)
  }
  const childIndexByParent = new Map<string, number>()
  for (const runNode of view.nodes) {
    if (!runNode.parentInstanceId) {
      continue
    }
    const parentPosition = positions.get(runNode.parentInstanceId) ?? { x: 0, y: 0 }
    const childIndex = childIndexByParent.get(runNode.parentInstanceId) ?? 0
    childIndexByParent.set(runNode.parentInstanceId, childIndex + 1)
    positions.set(runNode.instanceId, {
      x: parentPosition.x + 300 + childIndex * 280,
      y: parentPosition.y
    })
  }
  return positions
}

function PipelineRunGraphFlow({
  view,
  surface,
  row,
  ledger,
  readOnly,
  busy,
  onAnswer,
  onApprove,
  onAnswered
}: PipelineRunGraphProps): React.JSX.Element {
  const [activeControl, setActiveControl] = useState<PipelineRunNodeControl | null>(null)
  const parsedNodes = useMemo(
    () =>
      view.document.nodes.flatMap((node) => {
        const parsed = PipelineNodeSchema.safeParse(node)
        return parsed.success ? [parsed.data] : []
      }),
    [view.document.nodes]
  )
  const layoutDocument = useMemo<PipelineDocument>(
    () => ({
      ...view.document,
      nodes: parsedNodes
    }),
    [parsedNodes, view.document]
  )
  const positions = useMemo(() => flowPositions(view, layoutDocument), [layoutDocument, view])
  const nodes = useMemo<PipelineRunGraphNode[]>(
    () =>
      view.nodes.map((runNode) => {
        const sourceNode =
          view.document.nodes.find((candidate) => candidate.id === runNode.nodeId) ?? null
        return {
          id: runNode.instanceId,
          type: 'pipeline-run-node',
          position: positions.get(runNode.instanceId) ?? { x: 0, y: 0 },
          data: {
            node: displayNode(sourceNode, runNode),
            sourceNode,
            runNode
          },
          draggable: false,
          connectable: false,
          selectable: false,
          focusable: false
        }
      }),
    [positions, view]
  )
  const edges = useMemo(
    () => buildRunFlowEdges(view, new Set(nodes.map((node) => node.id))),
    [nodes, view]
  )
  const latestEscalations = useMemo(
    () => (ledger === null || ledger === undefined ? [] : getLatestEscalations(ledger)),
    [ledger]
  )
  const activeNode = activeControl
    ? view.nodes.find(
        (node) =>
          node.instanceId === activeControl.node.instanceId &&
          node.epoch === activeControl.node.epoch &&
          node.attempt === activeControl.node.attempt &&
          node.escalationId === activeControl.node.escalationId
      )
    : undefined
  const selectedEscalation = activeNode
    ? latestEscalations.find((entry) => entry.escalationId === activeNode.escalationId)
    : undefined
  const selectedApprovalScope =
    activeControl &&
    selectedEscalation?.approvalScope &&
    (selectedEscalation.status === 'open' || selectedEscalation.status === 'escalated') &&
    selectedEscalation.escalationKind === 'awaiting-approval' &&
    ledger &&
    sameApprovalScope(activeControl.scope, selectedEscalation.approvalScope) &&
    selectedEscalation.approvalScope.contentIdentity === `pipeline:${view.pin.contentHash}` &&
    getLatestApproval(ledger, selectedEscalation.approvalScope) === null
      ? selectedEscalation.approvalScope
      : undefined
  const choiceOpen = activeControl?.kind === 'choice' && selectedApprovalScope !== undefined
  const capabilityOpen = activeControl?.kind === 'capability' && selectedApprovalScope !== undefined
  const isUnknownWatcher = row?.entry.enrollment.kind === 'unknown' || view.kind === 'unknown'
  const controlsReadOnly =
    readOnly ||
    isUnknownWatcher ||
    row?.contact === 'unverifiable' ||
    row?.entry.status.state === 'unreachable'
  const startedAtMs =
    row?.entry.enrollment.createdAtMs ??
    Math.min(
      ...view.nodes.flatMap((node) => (node.startedAtMs === undefined ? [] : [node.startedAtMs])),
      view.asOfMs
    )
  const runTurns = view.nodes.reduce((total, node) => total + node.turns, 0)
  const nodeTypes = useMemo(() => ({ 'pipeline-run-node': RunGraphNode }), [])

  const controlFor = (runNode: PipelineRunNodeView): PipelineRunNodeControl | null =>
    pipelineRunNodeControl({
      runNode,
      view,
      row,
      ledger,
      latestEscalations,
      isUnknownWatcher
    })

  const openWorkerTerminal = (runNode: PipelineRunNodeView): void => {
    if (!runNode.workerNavigation) {
      return
    }
    const navigation = resolveHeimdallWorkerNavigation(
      runNode.workerNavigation,
      row?.target.connectionId ?? null
    )
    if (navigation) {
      openHeimdallWorker(navigation)
    }
  }

  const onNodeClick = (_event: unknown, node: PipelineRunGraphNode): void => {
    const { runNode, sourceNode } = node.data
    if (pipelineRunNodeOpensWorker({ runNode, sourceNode, isUnknownWatcher })) {
      openWorkerTerminal(runNode)
    }
    const control = controlFor(runNode)
    if (control) {
      setActiveControl(control)
    }
  }

  const getNodeMenuItems = (node: PipelineRunGraphNode): PipelineNodeContextMenuItem[] => {
    const current = nodes.find((candidate) => candidate.id === node.id)
    if (!current) {
      return []
    }
    const { runNode, sourceNode } = current.data
    const control = controlFor(runNode)
    return [
      ...(pipelineRunNodeOpensWorker({ runNode, sourceNode, isUnknownWatcher })
        ? [
            {
              key: 'open-worker',
              label: translate(
                'fork.heimdallPipeline.contextMenu.openWorker',
                'Open worker terminal'
              ),
              onSelect: () => openWorkerTerminal(runNode)
            }
          ]
        : []),
      ...(control
        ? [
            {
              key: 'answer',
              label: translate('fork.heimdallPipeline.contextMenu.answer', 'Answer'),
              onSelect: () => setActiveControl(control)
            }
          ]
        : []),
      copyNodeIdMenuItem(runNode.nodeId)
    ]
  }

  const answer = async (command: PipelineChoiceCommand): Promise<WatcherCommandResult | null> =>
    onAnswer ? onAnswer(command) : null
  const summaryTime = formatHeimdallDuration(Math.max(0, view.asOfMs - startedAtMs))
  return (
    <section
      className="space-y-2"
      aria-label={translate('fork.heimdallPipeline.runGraph.title', 'Run graph')}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{view.pin.label}</h3>
          <p className="text-xs text-muted-foreground">
            {translate('fork.heimdallPipeline.runGraph.title', 'Run graph')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
          <span>
            {translate('fork.heimdallPipeline.runGraph.runTime', 'Run time {{duration}}', {
              duration: summaryTime
            })}
          </span>
          <span>
            {translate('fork.heimdallPipeline.runGraph.runTurns', 'Run turns {{count}}', {
              count: runTurns
            })}
          </span>
        </div>
      </header>
      <PipelineNodeContextMenu<PipelineRunGraphNode>
        className="pipeline-flow h-[28rem]"
        data-testid="pipeline-run-graph"
        getItems={getNodeMenuItems}
      >
        {(onNodeContextMenu) => (
          <ReactFlow<PipelineRunGraphNode, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={pipelineEdgeTypes}
            fitView={nodes.length > 0}
            fitViewOptions={{ padding: 0.25 }}
            minZoom={0.2}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            panOnDrag
            zoomOnScroll
            deleteKeyCode={null}
            onNodeClick={onNodeClick}
            onNodeContextMenu={onNodeContextMenu}
            aria-label={translate(
              'fork.heimdallPipeline.runGraph.graphLabel',
              'Pipeline run graph'
            )}
          >
            <Background gap={24} size={1} />
          </ReactFlow>
        )}
      </PipelineNodeContextMenu>
      {activeControl?.kind === 'choice' && activeNode && selectedApprovalScope && row ? (
        <PipelineGateDialog
          key={selectedApprovalScope.evidenceKey}
          open={choiceOpen}
          onOpenChange={(open) => {
            if (!open) {
              setActiveControl(null)
            }
          }}
          view={view}
          node={activeNode}
          scope={selectedApprovalScope}
          row={row}
          readOnly={controlsReadOnly || !onAnswer}
          busy={busy ?? false}
          surface={surface}
          onAnswer={answer}
          onAnswered={onAnswered}
        />
      ) : null}
      {activeControl?.kind === 'capability' && activeNode && selectedApprovalScope ? (
        <CapabilityApprovalDialog
          key={selectedApprovalScope.evidenceKey}
          open={capabilityOpen}
          onOpenChange={(open) => {
            if (!open) {
              setActiveControl(null)
            }
          }}
          node={activeNode}
          scope={selectedApprovalScope}
          readOnly={controlsReadOnly}
          busy={busy ?? false}
          onApprove={onApprove}
          onAnswered={onAnswered}
        />
      ) : null}
    </section>
  )
}

export type PipelineRunGraphProps = {
  view: PipelineRunView
  surface: 'heimdall-detail' | 'canvas-run'
  onAnswered?: () => void
  row?: WatcherFleetEntryReader
  ledger?: WatcherLedger | null
  readOnly?: boolean
  busy?: boolean
  onAnswer?: (command: PipelineChoiceCommand) => Promise<WatcherCommandResult | null>
  onApprove?: (scope: ApprovalScope) => Promise<WatcherCommandResult | null>
}

export function PipelineRunGraph(props: PipelineRunGraphProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <PipelineRunGraphFlow {...props} />
    </ReactFlowProvider>
  )
}
