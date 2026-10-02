import type {
  PipelineDocument,
  PipelineNode
} from '../../../shared/fork-heimdall-pipeline/document-schema'
import type { PipelineLayout } from '../../../shared/fork-heimdall-pipeline/layout-schema'
import { NodeIdSchema } from '../../../shared/fork-heimdall-pipeline/node-id'
import {
  renderPipelineLayout,
  type PipelineEdit
} from '../../../shared/fork-heimdall-pipeline/yaml-writer'
import { layeredLayout } from './layered-layout'
export function renderPipelineLayoutForDocument(
  layout: PipelineLayout,
  document: PipelineDocument
): string {
  const nodes = Object.fromEntries(
    Object.entries(layout.nodes).filter(([id]) => NodeIdSchema.safeParse(id).success)
  )
  const nodeOrder = document.nodes.flatMap((node) =>
    NodeIdSchema.safeParse(node.id).success ? [node.id] : []
  )
  return renderPipelineLayout({ ...layout, nodes }, nodeOrder)
}

export function diffPipelineDocument(
  saved: PipelineDocument,
  draft: PipelineDocument
): PipelineEdit[] {
  const edits: PipelineEdit[] = []
  if (saved.id !== draft.id) {
    edits.push({ kind: 'set-top', key: 'id', value: draft.id })
  }
  if (saved.name !== draft.name) {
    edits.push({ kind: 'set-top', key: 'name', value: draft.name })
  }
  if (JSON.stringify(saved.description) !== JSON.stringify(draft.description)) {
    edits.push({ kind: 'set-top', key: 'description', value: draft.description })
  }
  if (JSON.stringify(saved.inputs) !== JSON.stringify(draft.inputs)) {
    edits.push({ kind: 'set-top', key: 'inputs', value: draft.inputs })
  }
  if (JSON.stringify(saved.capabilities) !== JSON.stringify(draft.capabilities)) {
    edits.push({ kind: 'set-top', key: 'capabilities', value: draft.capabilities })
  }
  if (JSON.stringify(saved.defaults) !== JSON.stringify(draft.defaults)) {
    edits.push({ kind: 'set-top', key: 'defaults', value: draft.defaults })
  }
  const savedById = new Map(saved.nodes.map((node) => [node.id, node]))
  const draftById = new Map(draft.nodes.map((node) => [node.id, node]))
  for (const node of saved.nodes) {
    if (!draftById.has(node.id)) {
      edits.push({ kind: 'delete-node', nodeId: node.id })
    }
  }
  for (const node of draft.nodes) {
    const previous = savedById.get(node.id)
    if (!previous) {
      edits.push({ kind: 'append-node', node })
    } else if (JSON.stringify(previous) !== JSON.stringify(node)) {
      edits.push({ kind: 'set-node', node })
    }
  }
  return edits
}

export type EditedPipelineNode = {
  document: PipelineDocument
  layout: PipelineLayout
  previousNode: PipelineNode
  editedNode: PipelineNode
}

export function editPipelineNodeDocument(
  document: PipelineDocument,
  layout: PipelineLayout,
  nodeId: string,
  update: (node: PipelineNode) => PipelineNode
): EditedPipelineNode | null {
  const nodeIndex = document.nodes.findIndex((node) => node.id === nodeId)
  const previousNode = document.nodes[nodeIndex]
  if (!previousNode) {
    return null
  }
  const editedNode = update(previousNode)
  let nodes = document.nodes.map((node, index) => (index === nodeIndex ? editedNode : node))
  if (editedNode.id !== previousNode.id) {
    nodes = nodes.map((node) => {
      const after = node.after?.map((entry) =>
        typeof entry === 'string'
          ? entry === previousNode.id
            ? editedNode.id
            : entry
          : { ...entry, node: entry.node === previousNode.id ? editedNode.id : entry.node }
      )
      if (node.type === 'agent' || node.type === 'check') {
        return {
          ...node,
          ...(after === undefined ? {} : { after }),
          ...(node.onFail?.sendBackTo === previousNode.id
            ? { onFail: { ...node.onFail, sendBackTo: editedNode.id } }
            : {})
        }
      }
      if (node.type === 'gate') {
        return {
          ...node,
          ...(after === undefined ? {} : { after }),
          ...(node.sendBackTo === previousNode.id ? { sendBackTo: editedNode.id } : {})
        }
      }
      if (node.type === 'loop') {
        return {
          ...node,
          ...(after === undefined ? {} : { after }),
          body: node.body.map((id) => (id === previousNode.id ? editedNode.id : id))
        }
      }
      if (node.type === 'merge') {
        return {
          ...node,
          ...(after === undefined ? {} : { after }),
          from: node.from === previousNode.id ? editedNode.id : node.from
        }
      }
      return { ...node, ...(after === undefined ? {} : { after }) }
    })
    const oldReference = `$${previousNode.id}.outputs.`
    const newReference = `$${editedNode.id}.outputs.`
    nodes = nodes.map((node) => {
      if (node.type === 'decision') {
        return { ...node, on: node.on.replaceAll(oldReference, newReference) }
      }
      if (node.type === 'loop') {
        return { ...node, until: node.until.replaceAll(oldReference, newReference) }
      }
      if (node.type === 'swarm') {
        return { ...node, from: node.from.replaceAll(oldReference, newReference) }
      }
      if (node.type === 'script' && node.inputs) {
        const inputs: Record<string, string> = {}
        for (const [key, value] of Object.entries(node.inputs)) {
          if (typeof value !== 'string') {
            return node
          }
          inputs[key] = value.replaceAll(oldReference, newReference)
        }
        return { ...node, inputs }
      }
      if (node.type === 'agent') {
        return { ...node, prompt: node.prompt.replaceAll(oldReference, newReference) }
      }
      return node
    })
  }
  const nextDocument = { ...document, nodes }
  const positions = { ...layout.nodes }
  if (editedNode.id !== previousNode.id) {
    const previousPosition = positions[previousNode.id]
    if (previousPosition) {
      positions[editedNode.id] = previousPosition
    }
    delete positions[previousNode.id]
  }
  return {
    document: nextDocument,
    layout: layeredLayout(nextDocument, { ...layout, nodes: positions }),
    previousNode,
    editedNode
  }
}

export function removePipelineNodeDocument(
  document: PipelineDocument,
  layout: PipelineLayout,
  nodeId: string
): { document: PipelineDocument; layout: PipelineLayout } | null {
  if (!document.nodes.some((node) => node.id === nodeId)) {
    return null
  }
  const nextDocument: PipelineDocument = {
    ...document,
    nodes: document.nodes
      .filter((node) => node.id !== nodeId)
      .map((node) => ({
        ...node,
        after: node.after?.filter(
          (entry) => (typeof entry === 'string' ? entry : entry.node) !== nodeId
        )
      }))
  }
  const positions = { ...layout.nodes }
  delete positions[nodeId]
  return {
    document: nextDocument,
    layout: layeredLayout(nextDocument, { ...layout, nodes: positions })
  }
}

export function connectPipelineNodes(
  document: PipelineDocument,
  sourceNodeId: string,
  targetNodeId: string,
  when?: string
): PipelineDocument | null {
  if (sourceNodeId === targetNodeId || !document.nodes.some((node) => node.id === sourceNodeId)) {
    return null
  }
  const target = document.nodes.find((node) => node.id === targetNodeId)
  if (!target) {
    return null
  }
  if (
    target.after?.some((entry) => (typeof entry === 'string' ? entry : entry.node) === sourceNodeId)
  ) {
    return null
  }
  const after = [
    ...(target.after ?? []),
    ...(when ? [{ node: sourceNodeId, when }] : [sourceNodeId])
  ]
  return {
    ...document,
    nodes: document.nodes.map((node) => (node.id === targetNodeId ? { ...node, after } : node))
  }
}

export function disconnectPipelineNodes(
  document: PipelineDocument,
  sourceNodeId: string,
  targetNodeId: string
): PipelineDocument | null {
  const target = document.nodes.find((node) => node.id === targetNodeId)
  if (
    !target?.after?.some(
      (entry) => (typeof entry === 'string' ? entry : entry.node) === sourceNodeId
    )
  ) {
    return null
  }
  const after = target.after.filter(
    (entry) => (typeof entry === 'string' ? entry : entry.node) !== sourceNodeId
  )
  return {
    ...document,
    nodes: document.nodes.map((node) =>
      node.id === targetNodeId
        ? { ...node, ...(after.length === 0 ? { after: undefined } : { after }) }
        : node
    )
  }
}
