import type { CapabilityMode } from '../fork-heimdall/watcher-types'
import {
  PIPELINE_CAPABILITY_KEYS as DOCUMENT_CAPABILITY_KEYS,
  type NodeType,
  type PipelineCapabilityKey,
  type PipelineDocument
} from './document-schema'

export const PIPELINE_CAPABILITY_KEYS = DOCUMENT_CAPABILITY_KEYS
export const PIPELINE_USER_CAPABILITY_KEYS = PIPELINE_CAPABILITY_KEYS.filter(
  (key): key is Exclude<PipelineCapabilityKey, 'gate' | 'pipeline'> =>
    key !== 'gate' && key !== 'pipeline'
)
export type PipelineUserCapabilityKey = Exclude<PipelineCapabilityKey, 'gate' | 'pipeline'>
export type PipelineCapabilityModes = Partial<Record<PipelineUserCapabilityKey, CapabilityMode>>

const NODE_CAPABILITY_NEEDS: Readonly<Record<NodeType, readonly PipelineUserCapabilityKey[]>> = {
  agent: ['agent'],
  check: ['check'],
  script: [],
  decision: [],
  loop: [],
  swarm: ['agent'],
  merge: ['integrate', 'agent'],
  gate: [],
  land: ['push', 'land'],
  objective: [],
  'pr-sitter': ['updateBranch', 'resolveConflicts', 'fixChecks', 'merge']
}

export function requestedCapabilities(document: PipelineDocument): PipelineCapabilityModes {
  const requested: PipelineCapabilityModes = {}
  for (const key of PIPELINE_USER_CAPABILITY_KEYS) {
    const explicit = document.capabilities?.[key]
    if (explicit !== undefined) {
      requested[key] = explicit
    }
  }
  for (const node of document.nodes) {
    const needs = [...NODE_CAPABILITY_NEEDS[node.type]]
    if (node.type === 'script') {
      needs.push(node.capability)
    }
    for (const key of needs) {
      if (requested[key] === undefined) {
        requested[key] = 'gated'
      }
    }
  }
  return requested
}

export function defaultGrants(
  requested: Readonly<PipelineCapabilityModes>
): PipelineCapabilityModes {
  const grants: PipelineCapabilityModes = {}
  for (const key of PIPELINE_USER_CAPABILITY_KEYS) {
    const mode = requested[key]
    if (mode !== undefined) {
      grants[key] = key === 'push' || key === 'merge' ? (mode === 'on' ? 'gated' : mode) : mode
    }
  }
  return grants
}
