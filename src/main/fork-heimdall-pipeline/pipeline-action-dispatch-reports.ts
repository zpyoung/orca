import { childTaskIdFromInstanceId } from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import { PipelineEnrollmentPayloadSchema } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import type { PipelineAgentNode } from '../../shared/fork-heimdall-pipeline/document-schema'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { ObjectiveWorkspaceTarget } from '../fork-heimdall-objective/content-identity'
import { resolveObjectiveWorkspaceTarget } from '../fork-heimdall-objective/workspace-target'
import { resolvePipelineChildTarget } from './pipeline-merge-source-reader'
import { pipelineAgentAttemptIdentity } from './agent-node-executor'
import type { ResolvePipelineAgentReportContext } from './agent-node-executor'
import type { PipelineActionDispatcherDependencies } from './pipeline-action-dispatch-contracts'
import {
  childWorktreeFact,
  currentIdentityMatches,
  runState,
  text
} from './pipeline-action-identity'
import { composeTarget, fileExists } from './pipeline-action-dispatch-workspace'
import type { PipelineReadyWorld } from './pipeline-kind-read'

export type ResolverActionValidator = (
  action: AttemptEntry['action'],
  world: PipelineReadyWorld,
  ledger: WatcherLedger
) => boolean

export function createPipelineAgentReportContext(
  dependencies: PipelineActionDispatcherDependencies,
  worlds: Map<string, PipelineReadyWorld>,
  validateResolver: ResolverActionValidator
): ResolvePipelineAgentReportContext {
  return async ({ enrollment: inputEnrollment, attempt, dispatch, baseline }) => {
    const world = worlds.get(attempt.watcherId)
    const enrollment = inputEnrollment ?? world?.enrollment
    if (enrollment === undefined || enrollment.watcherId !== attempt.watcherId) {
      throw new Error('Pipeline Agent report enrollment is unavailable')
    }
    const payload = PipelineEnrollmentPayloadSchema.parse(enrollment.kindPayload)
    const identity = pipelineAgentAttemptIdentity(attempt)
    if (
      identity === null ||
      attempt.action.contentIdentity !== `pipeline:${payload.pin.contentHash}`
    ) {
      throw new Error('Pipeline Agent report attempt identity changed')
    }
    let target: ObjectiveWorkspaceTarget
    if (attempt.action.kind === 'pipeline-resolve-merge-conflict') {
      const childInstanceId = text(attempt.action, 'childInstanceId')
      const worktreeId = text(attempt.action, 'workspaceId')
      if (
        world === undefined ||
        childInstanceId === null ||
        worktreeId === null ||
        !validateResolver(attempt.action, world, world.ledger) ||
        currentIdentityMatches(attempt.action, world, world.ledger) === null
      ) {
        throw new Error('Pipeline conflict resolver provenance is unavailable')
      }
      const childState = runState(world, world.ledger).nodes.get(childInstanceId)
      const worktree =
        childState === undefined
          ? null
          : childWorktreeFact(
              dependencies.pipelineStore.facts(enrollment.watcherId),
              childInstanceId,
              childState.epoch
            )
      if (
        worktree === null ||
        worktree.setupState !== 'ready' ||
        worktree.worktreeId !== worktreeId ||
        dispatch.instanceId !== identity.instanceId ||
        dispatch.epoch !== identity.epoch ||
        dispatch.attempt !== identity.attempt ||
        dispatch.workspaceId !== worktreeId ||
        text(attempt.action, 'childWorkspacePath') !== baseline.workspacePath
      ) {
        throw new Error('Pipeline conflict resolver worktree identity changed')
      }
      target = await resolvePipelineChildTarget({
        runtime: dependencies.runtime,
        enrollment,
        instanceId: childInstanceId,
        epoch: worktree.epoch,
        worktreeId: worktree.worktreeId
      })
    } else {
      const childTaskId = childTaskIdFromInstanceId(identity.instanceId)
      const documentNode = payload.document.nodes.find(
        (candidate) => candidate.id === identity.nodeId
      )
      if (
        childTaskId !== null &&
        documentNode?.type === 'swarm' &&
        documentNode.worktree === 'own'
      ) {
        if (
          world === undefined ||
          currentIdentityMatches(attempt.action, world, world.ledger) === null
        ) {
          throw new Error('Pipeline Agent child identity changed')
        }
        const childState = runState(world, world.ledger).nodes.get(identity.instanceId)
        const worktree =
          childState === undefined
            ? null
            : childWorktreeFact(
                dependencies.pipelineStore.facts(enrollment.watcherId),
                identity.instanceId,
                childState.epoch
              )
        if (
          worktree === null ||
          worktree.setupState !== 'ready' ||
          worktree.worktreeId !== dispatch.workspaceId ||
          dispatch.instanceId !== identity.instanceId ||
          dispatch.epoch !== identity.epoch ||
          dispatch.attempt !== identity.attempt
        ) {
          throw new Error('Pipeline Agent child worktree is not recorded and ready')
        }
        target = await resolvePipelineChildTarget({
          runtime: dependencies.runtime,
          enrollment,
          instanceId: identity.instanceId,
          epoch: worktree.epoch,
          worktreeId: worktree.worktreeId
        })
      } else {
        target = await resolveObjectiveWorkspaceTarget(dependencies.runtime, enrollment)
      }
    }
    if (
      target.workspacePath !== baseline.workspacePath ||
      (dispatch.workspaceId !== null &&
        (target.kind !== 'git' || target.gitTarget?.worktree.id !== dispatch.workspaceId))
    ) {
      throw new Error('Pipeline Agent report workspace changed')
    }
    const pipelineTarget = await composeTarget(
      target,
      target.kind === 'git' ? target.gitTarget?.worktree.id : undefined
    )
    let node: PipelineAgentNode
    if (attempt.action.kind === 'pipeline-resolve-merge-conflict') {
      const mergeId = text(attempt.action, 'mergeId')
      if (mergeId === null || mergeId !== identity.nodeId) {
        throw new Error('Conflict report node changed')
      }
      node = {
        id: mergeId,
        type: 'agent' as const,
        prompt: 'Resolve this pipeline Merge conflict.',
        outputs: { resolved: { type: 'boolean' as const } }
      }
    } else {
      const configured = payload.document.nodes.find(
        (candidate) => candidate.id === identity.nodeId
      )
      if (configured?.type === 'agent') {
        node = configured
      } else if (configured?.type === 'swarm') {
        node = { ...configured.child, id: configured.id, type: 'agent' as const }
      } else {
        throw new Error('Pipeline Agent report node configuration is unavailable')
      }
    }
    return {
      target: pipelineTarget,
      node,
      fileExists: (relativePath) => fileExists(target, relativePath)
    }
  }
}
