import type { KernelAction, WatcherLedger } from '../../fork-heimdall/ledger-types'
import type {
  PipelineLandNode,
  PipelineMergeNode,
  PipelineNode,
  PipelineSwarmNode
} from '../document-schema'
import type { PipelineTask } from '../task-list'
import type {
  PipelineLandingFacts,
  PipelineMergeSourceFacts,
  PipelineRunState,
  PipelineWorld
} from './index'
import { buildPipelineAction, landActionExpectedState } from './action-envelope'
import type { OutputMap } from './decision-types'
import { mergeOrder } from './merge-order'
import { pipelineOutputReference } from './decision-rules'
import { pipelineAttemptFacts, type PipelineAttemptFact } from './node-history'
import { childTaskIdFromInstanceId, nodeInstanceId } from './node-instance'
import { renderPrompt } from '../output-substitution'

export type LandActionResult = { action?: KernelAction; unavailable?: string; complete?: true }

export function buildPipelineSwarmExpansionAction(input: {
  world: PipelineWorld
  node: PipelineSwarmNode
  state: PipelineRunState
  epoch: number
  attempt: number
}): KernelAction {
  const reference = pipelineOutputReference(input.node.from)
  const tasks =
    reference === null
      ? undefined
      : input.state.nodes.get(reference.nodeId)?.outputs?.[reference.name]
  return buildPipelineAction({
    kind: 'pipeline-expand-swarm',
    capability: 'pipeline',
    visibility: 'local',
    pin: input.world.payload.pin,
    instanceId: input.node.id,
    nodeId: input.node.id,
    epoch: input.epoch,
    attempt: input.attempt,
    fields: {
      tasks,
      from: input.node.from,
      maxParallel: input.node.maxParallel,
      worktree: input.node.worktree
    }
  })
}

function latestMergeProgressRows(
  world: PipelineWorld,
  mergeId: string
): PipelineWorld['facts']['mergeProgress'] {
  const latestByChild = new Map<string, PipelineWorld['facts']['mergeProgress'][number]>()
  for (const row of world.facts.mergeProgress) {
    if (row.mergeId !== mergeId) {
      continue
    }
    const previous = latestByChild.get(row.childInstanceId)
    if (previous === undefined || row.epoch >= previous.epoch) {
      latestByChild.set(row.childInstanceId, row)
    }
  }
  return [...latestByChild.values()]
}

function appliedChildCommits(
  world: PipelineWorld,
  merge: PipelineMergeNode,
  taskOrder: readonly string[]
): { taskId: string; commitSha: string }[] {
  const applied: { taskId: string; commitSha: string }[] = []
  const progress = latestMergeProgressRows(world, merge.id)
  for (const taskId of taskOrder) {
    const childInstanceId = nodeInstanceId(merge.from, taskId)
    const latest = progress.find((row) => row.childInstanceId === childInstanceId)
    if (latest?.state === 'applied' && latest.commitSha !== null) {
      applied.push({ taskId, commitSha: latest.commitSha })
    }
  }
  return applied
}

export function buildPipelineMergeChildAction(input: {
  world: PipelineWorld
  node: PipelineMergeNode
  source: PipelineMergeSourceFacts
  epoch: number
  attempt: number
  tasks: readonly PipelineTask[]
  taskOrder: number
}): KernelAction {
  const taskId = childTaskIdFromInstanceId(input.source.childInstanceId) ?? ''
  const sourceIdentity =
    input.source.committedChildSha === null
      ? ['worktree', input.source.sourceHead, input.source.workspaceDigest]
      : ['commit', input.source.committedChildSha]
  const step = JSON.stringify([
    input.source.childInstanceId,
    sourceIdentity,
    input.source.applicableBaseCommit
  ])
  const orderedTaskIds = mergeOrder(input.tasks, new Set())
  const appliedChildren = appliedChildCommits(input.world, input.node, orderedTaskIds)
  return buildPipelineAction({
    kind: 'pipeline-merge-child',
    capability: 'integrate',
    visibility: 'local',
    pin: input.world.payload.pin,
    instanceId: input.node.id,
    nodeId: input.node.id,
    epoch: input.epoch,
    attempt: input.attempt,
    step,
    fields: {
      mergeId: input.node.id,
      childInstanceId: input.source.childInstanceId,
      taskId,
      childWorkspacePath: input.source.workspacePath,
      childCommitSha: input.source.committedChildSha,
      sourceHead: input.source.sourceHead,
      workspaceDigest: input.source.workspaceDigest,
      baseCommit: input.source.applicableBaseCommit,
      runWorkspacePath: input.world.workspacePath,
      appliedChildren,
      unmergedPaths: input.source.unmergedPaths,
      mergeOrder: input.taskOrder
    }
  })
}

export function mergeProgressFor(
  world: PipelineWorld,
  mergeId: string,
  childInstanceId: string
): PipelineWorld['facts']['mergeProgress'][number] | undefined {
  let latest: PipelineWorld['facts']['mergeProgress'][number] | undefined
  for (const row of world.facts.mergeProgress) {
    if (
      row.mergeId === mergeId &&
      row.childInstanceId === childInstanceId &&
      (latest === undefined || row.epoch >= latest.epoch)
    ) {
      latest = row
    }
  }
  return latest
}

export type MergeConflictInfo = {
  row: PipelineWorld['facts']['mergeProgress'][number]
  paths: string[]
  conflictingChildren: string[]
  detail: string
}

export function mergeConflictInfo(
  world: PipelineWorld,
  merge: PipelineMergeNode,
  skippedChildren: ReadonlySet<string> = new Set()
): MergeConflictInfo | null {
  const progress = latestMergeProgressRows(world, merge.id)
  let conflict: MergeConflictInfo['row'] | null = null
  for (const row of progress) {
    if (
      !skippedChildren.has(row.childInstanceId) &&
      (row.state === 'conflict' || row.state === 'resolving') &&
      row.conflict !== null &&
      (conflict === null || row.epoch >= conflict.epoch)
    ) {
      conflict = row
    }
  }
  if (conflict === null || conflict.conflict === null) {
    return null
  }
  const conflictingChildren = conflict.conflict.conflictingChildren
  const otherChildren =
    conflictingChildren.length === 0 ? '' : ` with ${conflictingChildren.join(', ')}`
  return {
    row: conflict,
    paths: conflict.conflict.paths,
    conflictingChildren,
    detail: `Merge conflict in ${conflict.childInstanceId}${otherChildren}: ${conflict.conflict.paths.join(', ')}`
  }
}

function renderLandText(world: PipelineWorld, outputs: OutputMap, text: string): string | null {
  const rendered = renderPrompt({
    prompt: text,
    outputs,
    runInputs: world.payload.runInputs,
    workspacePath: world.workspacePath
  })
  return rendered.ok ? rendered.text : null
}

function lastLandAttempt(
  ledger: WatcherLedger,
  nodeId: string,
  epoch: number
): PipelineAttemptFact | null {
  let latest: PipelineAttemptFact | null = null
  for (const attempt of pipelineAttemptFacts(ledger)) {
    if (
      attempt.identity.instanceId === nodeId &&
      attempt.identity.epoch === epoch &&
      (attempt.entry.action.kind === 'pipeline-land-commit' ||
        attempt.entry.action.kind === 'pipeline-land-push' ||
        attempt.entry.action.kind === 'pipeline-land-open-review') &&
      (latest === null || attempt.entry.atMs >= latest.entry.atMs)
    ) {
      latest = attempt
    }
  }
  return latest
}

function expectedLandFacts(facts: PipelineLandingFacts, branch: string, headSha: string) {
  return { ...facts, branch, headSha }
}

export function buildNextLandAction(input: {
  world: PipelineWorld
  ledger: WatcherLedger
  outputs: OutputMap
  node: PipelineLandNode
  epoch: number
  attempt: number
}): LandActionResult {
  const facts = input.world.landingFacts
  if (facts === undefined) {
    return { unavailable: `Land node ${input.node.id} has no fresh host landing facts` }
  }
  const previous = lastLandAttempt(input.ledger, input.node.id, input.epoch)
  const landed = previous?.entry.state === 'settled' && previous.effect === 'landed'
  if (previous?.entry.action.kind === 'pipeline-land-open-review' && landed) {
    return { complete: true }
  }
  const nextKind =
    previous === null || !landed
      ? (previous?.entry.action.kind ?? 'pipeline-land-commit')
      : previous.entry.action.kind === 'pipeline-land-commit'
        ? 'pipeline-land-push'
        : 'pipeline-land-open-review'
  if (nextKind === 'pipeline-land-commit') {
    const messageText = input.node.commitMessage ?? `Land ${input.world.payload.document.name}`
    const message = renderLandText(input.world, input.outputs, messageText)
    return message === null
      ? { unavailable: `Land commit message for ${input.node.id} could not be rendered` }
      : {
          action: buildPipelineAction({
            kind: 'pipeline-land-commit',
            capability: 'land',
            visibility: 'local',
            pin: input.world.payload.pin,
            instanceId: input.node.id,
            nodeId: input.node.id,
            epoch: input.epoch,
            attempt: input.attempt,
            fields: { message }
          })
        }
  }
  if (nextKind === 'pipeline-land-push') {
    if (facts.branch === null || facts.headSha === null || facts.pushTarget === null) {
      return { unavailable: `Land push target for ${input.node.id} is unavailable` }
    }
    const pushFacts = {
      ...expectedLandFacts(facts, facts.pushTarget.branch, facts.headSha),
      target: facts.pushTarget
    }
    const expectedState = landActionExpectedState('pipeline-land-push', pushFacts)
    if (expectedState === null) {
      return { unavailable: `Land push target for ${input.node.id} is incomplete` }
    }
    const step = JSON.stringify([
      'pipeline-land-push',
      facts.branch,
      facts.pushTarget.remote,
      facts.pushTarget.branch,
      facts.headSha,
      facts.pushTarget.remoteSha
    ])
    return {
      action: buildPipelineAction({
        kind: 'pipeline-land-push',
        capability: 'push',
        visibility: 'external',
        pin: input.world.payload.pin,
        instanceId: input.node.id,
        nodeId: input.node.id,
        epoch: input.epoch,
        attempt: input.attempt,
        step,
        fields: {
          branch: facts.pushTarget.branch,
          headSha: facts.headSha,
          target: facts.pushTarget,
          expectedState
        }
      })
    }
  }
  const review = facts.hostedReview
  if (
    facts.branch === null ||
    facts.headSha === null ||
    review === null ||
    review.base === null ||
    facts.pushTarget === null
  ) {
    return { unavailable: `Hosted review target for ${input.node.id} is unavailable` }
  }
  const title =
    input.node.title === undefined
      ? input.world.payload.document.name
      : renderLandText(input.world, input.outputs, input.node.title)
  const body =
    input.node.body === undefined
      ? (input.world.payload.document.description ?? '')
      : renderLandText(input.world, input.outputs, input.node.body)
  if (title === null || body === null) {
    return { unavailable: `Hosted review text for ${input.node.id} could not be rendered` }
  }
  const branch = facts.pushTarget.branch
  const reviewFacts = {
    ...expectedLandFacts(facts, branch, facts.headSha),
    target: facts.pushTarget,
    provider: review.provider,
    base: review.base,
    title,
    body,
    draft: input.node.draft
  }
  const expectedState = landActionExpectedState('pipeline-land-open-review', reviewFacts)
  if (expectedState === null) {
    return { unavailable: `Hosted review target for ${input.node.id} is incomplete` }
  }
  const step = JSON.stringify([
    'pipeline-land-open-review',
    facts.branch,
    review.provider,
    review.repoKey,
    facts.pushTarget.remote,
    branch,
    facts.headSha,
    review.base,
    title,
    body,
    input.node.draft
  ])
  return {
    action: buildPipelineAction({
      kind: 'pipeline-land-open-review',
      capability: 'land',
      visibility: 'external',
      pin: input.world.payload.pin,
      instanceId: input.node.id,
      nodeId: input.node.id,
      epoch: input.epoch,
      attempt: input.attempt,
      step,
      fields: {
        branch,
        headSha: facts.headSha,
        target: facts.pushTarget,
        provider: review.provider,
        repoKey: review.repoKey,
        base: review.base,
        title,
        body,
        draft: input.node.draft,
        expectedState
      }
    })
  }
}

export function buildPipelineCompositeActivationAction(input: {
  world: PipelineWorld
  node: Extract<PipelineNode, { type: 'pr-sitter' }>
  state: PipelineRunState
}): KernelAction | null {
  const land = input.world.payload.document.nodes.find(
    (node): node is PipelineLandNode => node.type === 'land'
  )
  if (land === undefined) {
    return null
  }
  const prUrl = input.state.nodes.get(land.id)?.outputs?.prUrl
  const prNumber = input.state.nodes.get(land.id)?.outputs?.prNumber
  const branch = input.state.nodes.get(land.id)?.outputs?.branch
  const provider = input.state.nodes.get(land.id)?.outputs?.provider
  if (
    typeof prUrl !== 'string' ||
    typeof prNumber !== 'number' ||
    typeof branch !== 'string' ||
    (provider !== 'github' && provider !== 'gitlab')
  ) {
    return null
  }
  const nodeState = input.state.nodes.get(input.node.id)
  return buildPipelineAction({
    kind: 'pipeline-activate-composite',
    capability: 'pipeline',
    visibility: 'local',
    pin: input.world.payload.pin,
    instanceId: input.node.id,
    nodeId: input.node.id,
    epoch: nodeState?.epoch ?? 0,
    attempt: nodeState?.attempt ?? 0,
    fields: {
      landInstanceId: land.id,
      prUrl,
      prNumber,
      branch,
      provider,
      repeatFixLimit: input.node.repeatFixLimit,
      branchUpdateMode: input.node.branchUpdateMode,
      mergeMethod: input.node.mergeMethod,
      mergeCheckScope: input.node.mergeCheckScope,
      capabilities: input.world.grants
    }
  })
}
