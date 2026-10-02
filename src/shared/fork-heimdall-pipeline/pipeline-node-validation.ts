import { isDeniedScriptEnvName } from './script-env'
import type { PipelineDocument, PipelineNode, PipelineOutputType } from './document-schema'
import { findOutputRefs, type PipelineOutputReference } from './output-substitution'
import type { PipelineValidationCode } from './pipeline-validate'

type OutputRefParts = { nodeId: string; outputName: string }
type AddPipelineError = (
  nodeId: string | null,
  nodeIndex: number | null,
  code: PipelineValidationCode,
  message: string,
  path?: (string | number)[]
) => void

export function validatePipelineNodeDetails(
  document: PipelineDocument,
  workspaceKind: 'git' | 'folder' | 'unknown',
  byId: ReadonlyMap<string, PipelineNode>,
  nodeIndexById: ReadonlyMap<string, number>,
  sitterNodes: readonly PipelineNode[],
  addError: AddPipelineError
): void {
  const ancestorsById = new Map<string, ReadonlySet<string>>()
  for (const node of document.nodes) {
    if (!ancestorsById.has(node.id)) {
      ancestorsById.set(node.id, getAncestors(node.id, byId))
    }
  }
  const loopMembership = new Map<string, Set<string>>()
  const loops = document.nodes.filter((node) => node.type === 'loop')
  for (const loop of loops) {
    if (loop.type === 'loop') {
      for (const bodyNodeId of loop.body) {
        const members = loopMembership.get(bodyNodeId) ?? new Set<string>()
        members.add(loop.id)
        loopMembership.set(bodyNodeId, members)
      }
    }
  }

  document.nodes.forEach((node, index) => {
    const ancestors = ancestorsById.get(node.id) ?? new Set<string>()
    if (
      node.type === 'agent' &&
      node.harness === undefined &&
      document.defaults?.harness === undefined
    ) {
      addError(node.id, index, 'missing-field', 'Agent requires a harness or defaults.harness', [
        'harness'
      ])
    }
    if (
      workspaceKind === 'folder' &&
      (node.type === 'land' || node.type === 'merge' || node.type === 'pr-sitter')
    ) {
      addError(node.id, index, 'git-only-node-in-folder', `${node.type} requires a git workspace`)
    }
    if (workspaceKind === 'folder' && node.type === 'swarm' && node.worktree === 'own') {
      addError(
        node.id,
        index,
        'own-worktree-in-folder',
        'Swarm worktrees must be shared in a folder workspace'
      )
    }

    for (const edge of node.after ?? []) {
      const sourceId = typeof edge === 'string' ? edge : edge.node
      const source = byId.get(sourceId)
      if (source === undefined) {
        addError(node.id, index, 'dangling-edge', `Node ${sourceId} does not exist`, ['after'])
      } else if (typeof edge !== 'string') {
        if (source.type !== 'decision') {
          addError(node.id, index, 'when-without-decision', `Node ${sourceId} is not a decision`, [
            'after'
          ])
        } else {
          const decisionReference = findOutputRefs(source.on).find(
            (reference) => reference.kind === 'output'
          )
          const decisionParts =
            decisionReference === undefined ? null : outputRefParts(decisionReference)
          const decisionSource = decisionParts === null ? undefined : byId.get(decisionParts.nodeId)
          const output =
            decisionParts === null || decisionSource === undefined
              ? undefined
              : declaredOutput(decisionSource, decisionParts.outputName)
          const allowedWhenValues = output === undefined ? [] : decisionWhenValues(output)
          if (
            output !== undefined &&
            allowedWhenValues !== null &&
            !allowedWhenValues.includes(edge.when)
          ) {
            addError(
              node.id,
              index,
              'decision-when-unknown',
              `Decision value ${edge.when} is not declared`,
              ['after']
            )
          }
        }
      }
    }

    for (const referenceText of nodeTextReferences(node)) {
      for (const reference of findOutputRefs(referenceText)) {
        outputIsAncestor(reference, node.id, index, byId, ancestors, addError)
      }
    }

    const specialOutputRefs: PipelineOutputReference[] = []
    if (node.type === 'decision') {
      specialOutputRefs.push(...findOutputRefs(node.on))
    } else if (node.type === 'loop' || node.type === 'swarm') {
      specialOutputRefs.push(...findOutputRefs(node.type === 'loop' ? node.until : node.from))
    }
    for (const reference of specialOutputRefs) {
      const parts = outputRefParts(reference)
      if (parts === null) {
        continue
      }
      const source = byId.get(parts.nodeId)
      if (source === undefined) {
        addError(
          node.id,
          index,
          'dangling-edge',
          `Output reference names unknown node ${parts.nodeId}`
        )
      } else {
        const output = declaredOutput(source, parts.outputName)
        if (output === undefined) {
          addError(
            node.id,
            index,
            'invalid-output-ref',
            `Node ${parts.nodeId} does not declare output ${parts.outputName}`
          )
        }
        if (node.type !== 'loop' && !ancestors.has(parts.nodeId)) {
          addError(
            node.id,
            index,
            'ref-not-upstream',
            `Referenced node ${parts.nodeId} is not upstream`
          )
        }
        if (node.type === 'swarm' && output !== undefined && output.type !== 'taskList') {
          addError(node.id, index, 'invalid-output-ref', 'Swarm source must have type taskList')
        }
        if (
          node.type === 'loop' &&
          (!node.body.includes(parts.nodeId) || (output !== undefined && output.type !== 'verdict'))
        ) {
          addError(
            node.id,
            index,
            'loop-until-invalid',
            'Loop until must reference a verdict output in its body'
          )
        }
      }
      if (node.type === 'loop' && !byId.has(parts.nodeId)) {
        addError(
          node.id,
          index,
          'loop-until-invalid',
          'Loop until must reference a verdict output in its body'
        )
      }
    }

    if (node.type === 'merge') {
      const source = byId.get(node.from)
      if (source === undefined) {
        addError(node.id, index, 'dangling-edge', `Merge source ${node.from} does not exist`, [
          'from'
        ])
      } else if (source.type !== 'swarm') {
        addError(
          node.id,
          index,
          'merge-source-not-swarm',
          `Merge source ${node.from} is not a swarm`,
          ['from']
        )
      }
    }

    if (node.type === 'loop') {
      const bodySet = new Set(node.body)
      let invalidBody = node.body.includes(node.id)
      for (const bodyNodeId of node.body) {
        if (!byId.has(bodyNodeId)) {
          addError(node.id, index, 'dangling-edge', `Loop body node ${bodyNodeId} does not exist`, [
            'body'
          ])
        }
        const memberships = loopMembership.get(bodyNodeId)
        if (memberships !== undefined && [...memberships].some((loopId) => loopId !== node.id)) {
          invalidBody = true
        }
      }
      for (let bodyIndex = 1; bodyIndex < node.body.length; bodyIndex += 1) {
        const bodyNodeId = node.body[bodyIndex]
        const bodyNode = bodyNodeId === undefined ? undefined : byId.get(bodyNodeId)
        if (bodyNode !== undefined && !afterNodeIds(bodyNode).some((id) => bodySet.has(id))) {
          invalidBody = true
        }
      }
      if (invalidBody) {
        addError(node.id, index, 'loop-body-invalid', 'Loop body is not a valid ordered subgraph', [
          'body'
        ])
      }
    }

    if (node.type === 'gate' && node.sendBackTo !== undefined) {
      if (!byId.has(node.sendBackTo)) {
        addError(
          node.id,
          index,
          'dangling-edge',
          `Send-back node ${node.sendBackTo} does not exist`,
          ['sendBackTo']
        )
      } else if (!ancestors.has(node.sendBackTo)) {
        addError(node.id, index, 'send-back-not-ancestor', 'Gate sendBackTo must be an ancestor', [
          'sendBackTo'
        ])
      }
    }
    if ('onFail' in node && node.onFail?.sendBackTo !== undefined) {
      const sendBackTo = node.onFail.sendBackTo
      if (!byId.has(sendBackTo)) {
        addError(node.id, index, 'dangling-edge', `Send-back node ${sendBackTo} does not exist`, [
          'onFail',
          'sendBackTo'
        ])
      } else if (!ancestors.has(sendBackTo)) {
        addError(
          node.id,
          index,
          'send-back-not-ancestor',
          'onFail.sendBackTo must be an ancestor',
          ['onFail', 'sendBackTo']
        )
      }
    }

    if (node.type === 'script') {
      if (findOutputRefs(node.command).length > 0) {
        addError(
          node.id,
          index,
          'ref-in-script-command',
          'Script command must not contain output references',
          ['command']
        )
      }
      for (const name of Object.keys(node.inputs ?? {})) {
        if (isDeniedScriptEnvName(name)) {
          addError(
            node.id,
            index,
            'script-env-denied',
            `Script environment name ${name} is denied`,
            ['inputs', name]
          )
        }
        const reference = node.inputs?.[name]
        if (reference !== undefined) {
          for (const outputRef of findOutputRefs(reference)) {
            outputIsAncestor(outputRef, node.id, index, byId, ancestors, addError)
          }
        }
      }
    }
  })

  addCycleErrors(document.nodes, byId, nodeIndexById, addError)

  for (const node of sitterNodes) {
    const index = nodeIndexById.get(node.id) ?? null
    const ancestors = ancestorsById.get(node.id) ?? new Set<string>()
    const hasLandAncestor = [...ancestors].some((id) => byId.get(id)?.type === 'land')
    if (document.nodes.length > 1 && !hasLandAncestor) {
      addError(node.id, index, 'pr-sitter-without-land', 'PR sitter must have a Land ancestor')
    }
  }
}

function outputRefParts(reference: PipelineOutputReference): OutputRefParts | null {
  if (reference.kind !== 'output') {
    return null
  }
  return { nodeId: reference.nodeId, outputName: reference.name }
}

function outputDefinitions(node: PipelineNode): Readonly<Record<string, PipelineOutputType>> {
  switch (node.type) {
    case 'agent':
      return node.outputs ?? {}
    case 'swarm':
      return node.child.outputs ?? {}
    case 'script':
      return node.outputs?.stdout === undefined ? {} : { stdout: { type: 'text' as const } }
    case 'check':
    case 'decision':
    case 'loop':
    case 'merge':
    case 'gate':
    case 'land':
    case 'objective':
    case 'pr-sitter':
      return {}
  }
}

function declaredOutput(node: PipelineNode, outputName: string): PipelineOutputType | undefined {
  const outputs = outputDefinitions(node)
  return Object.hasOwn(outputs, outputName) ? outputs[outputName] : undefined
}

function afterNodeIds(node: PipelineNode): string[] {
  return (node.after ?? []).map((edge) => (typeof edge === 'string' ? edge : edge.node))
}

function getAncestors(nodeId: string, byId: ReadonlyMap<string, PipelineNode>): Set<string> {
  const ancestors = new Set<string>()
  const startingNode = byId.get(nodeId)
  const pending = startingNode === undefined ? [] : afterNodeIds(startingNode)
  while (pending.length > 0) {
    const ancestorId = pending.pop()
    if (ancestorId === undefined || ancestors.has(ancestorId)) {
      continue
    }
    const ancestor = byId.get(ancestorId)
    if (ancestor !== undefined) {
      ancestors.add(ancestorId)
      pending.push(...afterNodeIds(ancestor))
    }
  }
  return ancestors
}

function nodeTextReferences(node: PipelineNode): string[] {
  switch (node.type) {
    case 'agent':
      return [node.prompt]
    case 'swarm':
      return [node.child.prompt]
    case 'land':
      return [node.title, node.body, node.commitMessage].filter(
        (value): value is string => value !== undefined
      )
    case 'check':
    case 'decision':
    case 'script':
    case 'loop':
    case 'merge':
    case 'gate':
    case 'objective':
    case 'pr-sitter':
      return []
  }
}

function outputIsAncestor(
  reference: PipelineOutputReference,
  nodeId: string,
  nodeIndex: number,
  byId: ReadonlyMap<string, PipelineNode>,
  ancestors: ReadonlySet<string>,
  addError: AddPipelineError
): OutputRefParts | null {
  const parts = outputRefParts(reference)
  if (parts === null) {
    return null
  }
  const sourceNode = byId.get(parts.nodeId)
  if (sourceNode === undefined) {
    addError(
      nodeId,
      nodeIndex,
      'dangling-edge',
      `Output reference names unknown node ${parts.nodeId}`
    )
    return parts
  }
  if (declaredOutput(sourceNode, parts.outputName) === undefined) {
    addError(
      nodeId,
      nodeIndex,
      'invalid-output-ref',
      `Node ${parts.nodeId} does not declare output ${parts.outputName}`
    )
  }
  if (!ancestors.has(parts.nodeId)) {
    addError(
      nodeId,
      nodeIndex,
      'ref-not-upstream',
      `Referenced node ${parts.nodeId} is not upstream`
    )
  }
  return parts
}

function decisionWhenValues(output: PipelineOutputType): readonly string[] | null {
  switch (output.type) {
    case 'enum':
      return output.values
    case 'boolean':
      return ['true', 'false']
    case 'verdict':
      return ['approve', 'revise', 'escalate']
    case 'text':
    case 'number':
      return null
    case 'json':
    case 'file':
    case 'taskList':
      return []
  }
}

function addCycleErrors(
  nodes: readonly PipelineNode[],
  byId: ReadonlyMap<string, PipelineNode>,
  nodeIndexById: ReadonlyMap<string, number>,
  addError: AddPipelineError
): void {
  const state = new Map<string, 'visiting' | 'visited'>()
  const stack: string[] = []
  const cyclic = new Set<string>()
  const visit = (nodeId: string): void => {
    const currentState = state.get(nodeId)
    if (currentState === 'visited') {
      return
    }
    if (currentState === 'visiting') {
      const cycleStart = stack.indexOf(nodeId)
      for (const member of stack.slice(cycleStart)) {
        cyclic.add(member)
      }
      return
    }
    state.set(nodeId, 'visiting')
    stack.push(nodeId)
    const node = byId.get(nodeId)
    if (node !== undefined) {
      for (const dependencyId of afterNodeIds(node)) {
        if (byId.has(dependencyId)) {
          visit(dependencyId)
        }
      }
    }
    stack.pop()
    state.set(nodeId, 'visited')
  }
  for (const node of nodes) {
    visit(node.id)
  }
  for (const nodeId of cyclic) {
    addError(nodeId, nodeIndexById.get(nodeId) ?? null, 'cycle', `Node ${nodeId} is in a cycle`)
  }
}
