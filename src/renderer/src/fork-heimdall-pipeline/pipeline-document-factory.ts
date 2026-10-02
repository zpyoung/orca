import { translate } from '@/i18n/i18n'
import type {
  NodeType,
  PipelineDocument,
  PipelineNode
} from '../../../shared/fork-heimdall-pipeline/document-schema'

export function createPipelineNode(
  type: NodeType,
  id: string,
  document: PipelineDocument
): PipelineNode {
  switch (type) {
    case 'agent':
      return { id, type, prompt: '' }
    case 'check':
      return { id, type, command: '', timeoutSeconds: 1800 }
    case 'script':
      return { id, type, command: '', capability: 'script' }
    case 'decision':
      return { id, type, on: '' }
    case 'loop':
      return { id, type, body: [], until: '', maxRounds: 3 }
    case 'swarm':
      return {
        id,
        type,
        from: '',
        maxParallel: 5,
        worktree: 'own',
        child: {
          harness: document.defaults?.harness ?? '',
          prompt: ''
        }
      }
    case 'merge':
      return { id, type, from: '' }
    case 'gate':
      return {
        id,
        type,
        label: translate('fork.heimdallPipeline.node.gate', 'Human gate'),
        notify: true
      }
    case 'land':
      return { id, type, draft: false }
    case 'objective':
      return {
        id,
        type,
        tier: 'standard',
        landingBar: 'files-on-disk',
        lanesEnabled: true
      }
    case 'pr-sitter':
      return {
        id,
        type,
        repeatFixLimit: 3,
        branchUpdateMode: 'merge-base-update',
        mergeMethod: null,
        mergeCheckScope: 'all'
      }
  }
}

export function createPipelineDocument(id: string, name = id): PipelineDocument {
  return {
    version: 1,
    id,
    name,
    inputs: { task: { type: 'text', required: true } },
    nodes: []
  }
}

export function nextPipelineNodeId(type: NodeType, nodes: readonly PipelineNode[]): string {
  const occupied = new Set(nodes.map((node) => node.id))
  if (!occupied.has(type)) {
    return type
  }
  let suffix = 2
  while (occupied.has(`${type}-${suffix}`)) {
    suffix += 1
  }
  return `${type}-${suffix}`
}
