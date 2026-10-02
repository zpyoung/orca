import { isObjectiveGitObjectId } from '../../shared/fork-heimdall-objective/git-object-id'
import type { PipelineMergeSourceFacts } from '../../shared/fork-heimdall-pipeline/interpreter'
import { derivePipelineRunState } from '../../shared/fork-heimdall-pipeline/interpreter'
import { mergeOrder } from '../../shared/fork-heimdall-pipeline/interpreter/merge-order'
import {
  childTaskIdFromInstanceId,
  nodeInstanceId
} from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { PipelineStore } from './pipeline-store'
import {
  objectiveGitCommandForTarget,
  type ObjectiveWorkspaceTarget,
  type ObjectiveWorkspaceTarget as RuntimeObjectiveWorkspaceTarget
} from '../fork-heimdall-objective/content-identity'
import { requireRuntimeFileProvider } from '../runtime/runtime-file-command-target'
import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'
import { readMergeSourceFacts, type ReadMergeSourceFactsInput } from './merge-executor'
import { pipelineChildWorktreeMarker } from './swarm-executor'
import type { PipelineMergeSourceReadInput } from './pipeline-kind-read'
type PipelineMergeSourceReadDependencies = Readonly<{
  runtime: OrcaRuntimeService
  pipelineStore: PipelineStore
}>

function childWorktreeFact(
  facts: PipelineStoreFacts,
  instanceId: string,
  epoch: number
): PipelineStoreFacts['childWorktrees'][number] | null {
  let selected: PipelineStoreFacts['childWorktrees'][number] | null = null
  for (const fact of facts.childWorktrees) {
    if (fact.instanceId === instanceId && fact.epoch === epoch) {
      selected = fact
    }
  }
  return selected
}

function latestMergeProgress(
  facts: PipelineStoreFacts,
  mergeId: string,
  childInstanceId: string,
  epoch: number
): PipelineStoreFacts['mergeProgress'][number] | null {
  let selected: PipelineStoreFacts['mergeProgress'][number] | null = null
  for (const fact of facts.mergeProgress) {
    if (
      fact.mergeId === mergeId &&
      fact.childInstanceId === childInstanceId &&
      fact.epoch === epoch
    ) {
      selected = fact
    }
  }
  return selected
}

/** Resolves a private child only through its recorded marker and host-owned worktree identity. */
export async function resolvePipelineChildTarget(args: {
  runtime: OrcaRuntimeService
  enrollment: WatcherEnrollment
  instanceId: string
  epoch: number
  worktreeId: string
}): Promise<RuntimeObjectiveWorkspaceTarget> {
  // SAFETY: resolveRuntimeGitTarget is installed on OrcaRuntimeService's prototype but omitted from its IPC-facing exported surface; it is the host-authoritative resolver used by Objective and Merge.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: runtime is a fully constructed OrcaRuntimeService.
  const resolver = args.runtime as unknown as Readonly<{
    resolveRuntimeGitTarget(selector: string): Promise<RuntimeGitTarget>
  }>
  const target = await resolver.resolveRuntimeGitTarget(`id:${args.worktreeId}`)
  const expectedMarker = pipelineChildWorktreeMarker({
    watcherId: args.enrollment.watcherId,
    instanceId: args.instanceId,
    epoch: args.epoch
  })
  if (
    target.worktree.id !== args.worktreeId ||
    target.worktree.repoId !== args.enrollment.repoId ||
    target.executionHostId !== args.enrollment.executionHostId ||
    target.worktree.comment !== expectedMarker ||
    !target.worktree.path ||
    target.worktree.git.isBare ||
    target.worktree.git.prunable
  ) {
    throw new Error('Pipeline child worktree identity changed')
  }
  return {
    kind: 'git',
    executionHostId: target.executionHostId,
    workspacePath: target.worktree.path,
    fileProvider: requireRuntimeFileProvider(target),
    gitTarget: target
  }
}

async function gitHead(target: ObjectiveWorkspaceTarget): Promise<string> {
  if (target.kind !== 'git') {
    throw new Error('Pipeline Merge requires an authoritative Git workspace')
  }
  const result = await objectiveGitCommandForTarget(target)(['rev-parse', '--verify', 'HEAD'])
  const head = result.stdout.trim()
  if (!isObjectiveGitObjectId(head)) {
    throw new Error('Git returned an invalid Merge base commit')
  }
  return head
}

function recordedMergeActionBase(
  ledger: WatcherLedger,
  mergeId: string,
  childInstanceId: string
): string | null {
  let baseCommit: string | null = null
  for (const entry of ledger.entries) {
    if (
      entry.kind === 'attempt' &&
      entry.action.kind === 'pipeline-merge-child' &&
      entry.action.mergeId === mergeId &&
      entry.action.childInstanceId === childInstanceId &&
      typeof entry.action.baseCommit === 'string'
    ) {
      baseCommit = entry.action.baseCommit
    }
  }
  return baseCommit
}

function applicableMergeBase(args: {
  expansionBase: string | null
  progress: PipelineStoreFacts['mergeProgress'][number] | null
  recordedActionBase: string | null
  currentRunHead: string | null
}): string {
  if (
    args.progress?.state === 'conflict' ||
    args.progress?.state === 'resolving' ||
    args.progress?.state === 'resolved'
  ) {
    if (args.currentRunHead === null) {
      throw new Error('Pipeline Merge current head is unavailable')
    }
    return args.currentRunHead
  }
  if (args.progress?.state === 'pending' && args.recordedActionBase !== null) {
    return args.recordedActionBase
  }
  if (args.expansionBase === null) {
    throw new Error('Pipeline Swarm expansion has no recorded base commit')
  }
  return args.expansionBase
}

/** Reads fresh host-owned Merge child facts without creating commits or changing worktrees. */
export async function readPipelineMergeSources(
  dependencies: PipelineMergeSourceReadDependencies,
  input: PipelineMergeSourceReadInput
): Promise<Readonly<Record<string, PipelineMergeSourceFacts>>> {
  if (input.target.kind !== 'git') {
    return {}
  }
  const state = derivePipelineRunState({
    payload: input.payload,
    ledger: input.ledger,
    facts: input.facts,
    nowMs: input.nowMs,
    hasOwner: input.hasOwner,
    unverifiableDispatchIds: input.unverifiableDispatchIds,
    composites: input.composites
  })
  const sources: Record<string, PipelineMergeSourceFacts> = {}
  let runHead: string | null = null

  for (const merge of input.payload.document.nodes) {
    if (merge.type !== 'merge') {
      continue
    }
    const mergeState = state.nodes.get(merge.id)
    if (mergeState?.status !== 'ready' && mergeState?.status !== 'waiting') {
      continue
    }
    const swarm = input.payload.document.nodes.find(
      (node) => node.type === 'swarm' && node.id === merge.from
    )
    if (swarm?.type !== 'swarm') {
      continue
    }
    const swarmState = state.nodes.get(swarm.id)
    const expansion = input.facts.swarmExpansions.find(
      (fact) => fact.swarmId === swarm.id && fact.epoch === (swarmState?.epoch ?? 0)
    )
    if (expansion === undefined || expansion.baseCommit === null) {
      continue
    }
    const skipped = new Set(
      expansion.tasks.flatMap((task) =>
        state.nodes.get(nodeInstanceId(swarm.id, task.id))?.status === 'skipped' ? [task.id] : []
      )
    )
    const progressForTask = (taskId: string) =>
      latestMergeProgress(input.facts, merge.id, nodeInstanceId(swarm.id, taskId), mergeState.epoch)
    const conflictProgress = expansion.tasks
      .map((task) => progressForTask(task.id))
      .find(
        (progress) =>
          progress !== null && (progress.state === 'conflict' || progress.state === 'resolving')
      )
    const conflictTaskId =
      conflictProgress === undefined || conflictProgress === null
        ? null
        : childTaskIdFromInstanceId(conflictProgress.childInstanceId)
    const candidateTaskIds = conflictProgress
      ? conflictTaskId === null
        ? []
        : [conflictTaskId]
      : mergeOrder(expansion.tasks, skipped)
          .filter((taskId) => {
            const progress = progressForTask(taskId)
            const childState = state.nodes.get(nodeInstanceId(swarm.id, taskId))
            return (
              childState?.status === 'done' &&
              progress?.state !== 'applied' &&
              progress?.state !== 'skipped'
            )
          })
          .slice(0, 1)

    for (const taskId of candidateTaskIds) {
      const childInstanceId = nodeInstanceId(swarm.id, taskId)
      const progress = progressForTask(taskId)
      const childState = state.nodes.get(childInstanceId)
      const childFact = childWorktreeFact(
        input.facts,
        childInstanceId,
        childState?.epoch ?? swarmState?.epoch ?? 0
      )
      let childTarget: RuntimeObjectiveWorkspaceTarget | null = null
      let childWorkspacePath: string | null = null
      if (swarm.worktree === 'own') {
        if (childFact?.setupState !== 'ready') {
          continue
        }
        childTarget = await resolvePipelineChildTarget({
          runtime: dependencies.runtime,
          enrollment: input.enrollment,
          instanceId: childInstanceId,
          epoch: childFact.epoch,
          worktreeId: childFact.worktreeId
        })
        childWorkspacePath = childTarget.workspacePath
      } else if (childFact !== null && childFact.setupState === 'ready') {
        throw new Error('A shared Swarm child has an unexpected private worktree')
      }
      const needsMergedHead =
        progress?.state === 'conflict' ||
        progress?.state === 'resolving' ||
        progress?.state === 'resolved'
      const mergeHead = needsMergedHead ? (runHead ??= await gitHead(input.target)) : null
      const applicableBaseCommit = applicableMergeBase({
        expansionBase: expansion.baseCommit,
        progress,
        recordedActionBase: recordedMergeActionBase(input.ledger, merge.id, childInstanceId),
        currentRunHead: mergeHead
      })
      const sourceInput: ReadMergeSourceFactsInput = {
        watcherId: input.enrollment.watcherId,
        mergeId: merge.id,
        epoch: mergeState.epoch,
        childInstanceId,
        workspacePath: childWorkspacePath,
        runWorkspacePath: input.enrollment.workspacePath,
        applicableBaseCommit,
        ...(progress?.commitSha === null || progress?.commitSha === undefined
          ? {}
          : { childCommitSha: progress.commitSha })
      }
      const targets = new Map<string, ObjectiveWorkspaceTarget>([
        [input.target.workspacePath, input.target],
        ...(childTarget === null ? [] : [[childTarget.workspacePath, childTarget] as const])
      ])
      const source = await readMergeSourceFacts(sourceInput, {
        store: dependencies.pipelineStore,
        resolveTarget: async (workspacePath) => {
          const resolved = targets.get(workspacePath)
          if (resolved === undefined) {
            throw new Error(
              'Pipeline Merge source path is not an enrolled or recorded child workspace'
            )
          }
          return resolved
        }
      })
      sources[childInstanceId] = source
    }
  }
  return sources
}
