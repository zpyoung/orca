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
  type NodeType
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
import { buildEditFlowEdges, pipelineEdgeTypes } from './PipelineFlowEdge'
import { PIPELINE_NODE_DRAG_TYPE } from './PipelinePalette'
import { validationMessagesByNode } from './pipeline-node-validation-messages'
import { pipelineCanvasNodeTypes, type PipelineCanvasNode } from './pipeline-node-views'

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
  const validationMessages = useMemo(
    () => validationMessagesByNode(draft.validation),
    [draft.validation]
  )
  const nodes = useMemo<PipelineCanvasNode[]>(
    () =>
      draft.draftDocument.nodes.map((node) => {
        const messages = validationMessages.get(node.id)
        return {
          id: node.id,
          type: node.type,
          position: draft.layout.nodes[node.id] ?? { x: 0, y: 0 },
          data: messages ? { node, validationMessages: messages } : { node },
          selected: node.id === selectedNodeId,
          draggable: !readOnly,
          connectable: !readOnly
        }
      }),
    [draft.draftDocument.nodes, draft.layout.nodes, readOnly, selectedNodeId, validationMessages]
  )
  const edges = useMemo(() => buildEditFlowEdges(draft.draftDocument), [draft.draftDocument])
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
    (node: PipelineCanvasNode): PipelineNodeContextMenuItem[] => {
      if (!draft.draftDocument.nodes.some((candidate) => candidate.id === node.id)) {
        return []
      }
      return [
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
      ]
    },
    [draft.draftDocument.nodes, file.id, readOnly, removeNode, selectNode]
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
            edgeTypes={pipelineEdgeTypes}
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
