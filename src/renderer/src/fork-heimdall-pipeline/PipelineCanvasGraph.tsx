import { useCallback, useMemo, useRef, type DragEvent, type JSX } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type NodeChange,
  type NodeMouseHandler,
  type OnMoveEnd
} from '@xyflow/react'
import { translate } from '@/i18n/i18n'
import type { OpenFile } from '@/store/slices/editor'
import {
  PIPELINE_NODE_TYPES,
  type NodeType,
  type PipelineDocument
} from '../../../shared/fork-heimdall-pipeline/document-schema'
import {
  usePipelineCanvasDraftStore,
  type PipelineCanvasDraft
} from './pipeline-canvas-draft-store'
import {
  copyNodeIdMenuItem,
  PipelineNodeContextMenu,
  type PipelineNodeContextMenuItem
} from './PipelineNodeContextMenu'
import { PIPELINE_NODE_DRAG_TYPE } from './PipelinePalette'
import { pipelineCanvasNodeTypes, type PipelineCanvasNode } from './pipeline-node-views'

function buildFlowEdges(document: PipelineDocument): Edge[] {
  const edges: Edge[] = []
  for (const target of document.nodes) {
    for (const [index, dependency] of (target.after ?? []).entries()) {
      const source = typeof dependency === 'string' ? dependency : dependency.node
      edges.push({
        id: `${source}:${target.id}:${index}`,
        source,
        target: target.id,
        sourceHandle: 'pipeline-output',
        targetHandle: 'pipeline-input',
        type: 'smoothstep',
        ...(typeof dependency === 'string' ? {} : { label: dependency.when })
      })
    }
  }
  return edges
}

export function PipelineCanvasGraph({
  file,
  draft,
  selectedNodeId,
  readOnly,
  onSelectNode,
  onAddNode
}: {
  file: OpenFile
  draft: PipelineCanvasDraft
  selectedNodeId: string | null
  readOnly: boolean
  onSelectNode: (nodeId: string | null) => void
  onAddNode: (type: NodeType) => void
}): JSX.Element {
  const { screenToFlowPosition } = useReactFlow<PipelineCanvasNode, Edge>()
  const { connect, disconnect, moveNode, removeNode, setViewport } =
    usePipelineCanvasDraftStore.getState()
  const selectedNodeIdRef = useRef(selectedNodeId)
  selectedNodeIdRef.current = selectedNodeId
  const selectNode = useCallback(
    (nodeId: string | null): void => {
      if (selectedNodeIdRef.current === nodeId) {
        return
      }
      selectedNodeIdRef.current = nodeId
      onSelectNode(nodeId)
    },
    [onSelectNode]
  )
  const nodes = useMemo<PipelineCanvasNode[]>(
    () =>
      draft.draftDocument.nodes.map((node) => ({
        id: node.id,
        type: node.type,
        position: draft.layout.nodes[node.id] ?? { x: 0, y: 0 },
        data: { node },
        selected: node.id === selectedNodeId,
        draggable: !readOnly,
        connectable: !readOnly
      })),
    [draft.draftDocument.nodes, draft.layout.nodes, readOnly, selectedNodeId]
  )
  const edges = useMemo(() => buildFlowEdges(draft.draftDocument), [draft.draftDocument])
  const selectedNode = draft.draftDocument.nodes.find((node) => node.id === selectedNodeId) ?? null

  const onNodesChange = useCallback(
    (changes: NodeChange<PipelineCanvasNode>[]) => {
      let nextSelectedNodeId: string | null = null
      let hasSelectedNode = false
      let deselectedCurrentNode = false
      for (const change of changes) {
        if (change.type !== 'select') {
          continue
        }
        if (change.selected) {
          if (!hasSelectedNode || change.id === selectedNodeIdRef.current) {
            nextSelectedNodeId = change.id
          }
          hasSelectedNode = true
        } else if (change.id === selectedNodeIdRef.current) {
          deselectedCurrentNode = true
        }
      }
      if (hasSelectedNode) {
        selectNode(nextSelectedNodeId)
      } else if (deselectedCurrentNode) {
        selectNode(null)
      }
      for (const change of changes) {
        if (change.type === 'position' && change.position) {
          moveNode(file.id, change.id, change.position)
        } else if (change.type === 'remove' && !readOnly) {
          removeNode(file.id, change.id)
          if (selectedNodeIdRef.current === change.id) {
            selectNode(null)
          }
        }
      }
    },
    [file.id, moveNode, readOnly, removeNode, selectNode]
  )

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      if (readOnly) {
        return
      }
      for (const change of changes) {
        if (change.type !== 'remove') {
          continue
        }
        const edge = edges.find((candidate) => candidate.id === change.id)
        if (edge?.source && edge.target) {
          disconnect(file.id, edge.source, edge.target)
        }
      }
    },
    [disconnect, edges, file.id, readOnly]
  )

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!readOnly && connection.source && connection.target) {
        connect(file.id, connection.source, connection.target)
      }
    },
    [connect, file.id, readOnly]
  )

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      if (readOnly) {
        return
      }
      const droppedType = event.dataTransfer.getData(PIPELINE_NODE_DRAG_TYPE)
      const type = PIPELINE_NODE_TYPES.find((candidate) => candidate === droppedType)
      if (!type) {
        return
      }
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      onAddNode(type)
      const current = usePipelineCanvasDraftStore.getState().drafts[file.id]
      const addedNode = current?.draftDocument.nodes.at(-1)
      if (addedNode) {
        moveNode(file.id, addedNode.id, position)
      }
    },
    [file.id, moveNode, onAddNode, readOnly, screenToFlowPosition]
  )
  const onNodeClick = useCallback<NodeMouseHandler<PipelineCanvasNode>>(
    (_event, node) => selectNode(node.id),
    [selectNode]
  )
  const onPaneClick = useCallback(() => selectNode(null), [selectNode])
  const getNodeMenuItems = useCallback(
    (node: PipelineCanvasNode): PipelineNodeContextMenuItem[] => [
      {
        key: 'inspect',
        label: translate('fork.heimdallPipeline.contextMenu.inspect', 'Inspect'),
        onSelect: () => selectNode(node.id)
      },
      ...(readOnly
        ? []
        : [
            {
              key: 'delete',
              label: translate('fork.heimdallPipeline.contextMenu.deleteNode', 'Delete node'),
              destructive: true,
              onSelect: () => {
                removeNode(file.id, node.id)
                if (selectedNodeIdRef.current === node.id) {
                  selectNode(null)
                }
              }
            }
          ]),
      copyNodeIdMenuItem(node.id)
    ],
    [file.id, readOnly, removeNode, selectNode]
  )
  const onMoveEnd = useCallback<OnMoveEnd>(
    (_event, viewport) => setViewport(file.id, viewport),
    [file.id, setViewport]
  )

  return (
    <PipelineNodeContextMenu<PipelineCanvasNode>
      className="pipeline-flow"
      getItems={getNodeMenuItems}
      onDrop={onDrop}
      onDragOver={(event) => {
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
      }}
    >
      {(onNodeContextMenu) => (
        <>
          <ReactFlow<PipelineCanvasNode, Edge>
            key={file.id}
            nodes={nodes}
            edges={edges}
            nodeTypes={pipelineCanvasNodeTypes}
            defaultViewport={draft.layout.viewport}
            fitView={nodes.length > 0 && !draft.layout.viewport}
            minZoom={0.2}
            nodesConnectable={!readOnly}
            elementsSelectable
            deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onNodeContextMenu={onNodeContextMenu}
            onPaneClick={onPaneClick}
            onMoveEnd={onMoveEnd}
            aria-label={translate('fork.heimdallPipeline.canvas.graph', 'Pipeline graph')}
          >
            <Background gap={24} size={1} />
            <Controls position="bottom-right" />
            <MiniMap pannable zoomable position="bottom-left" />
          </ReactFlow>
          {nodes.length === 0 ? (
            <div className="pipeline-canvas__empty">
              {translate(
                'fork.heimdallPipeline.canvas.empty',
                'Add a node from the palette to start this graph.'
              )}
            </div>
          ) : null}
          {selectedNode ? <span className="sr-only">{selectedNode.id}</span> : null}
        </>
      )}
    </PipelineNodeContextMenu>
  )
}
