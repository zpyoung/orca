import { isDeepStrictEqual } from 'node:util'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import { isObjectiveGitObjectId } from '../../shared/fork-heimdall-objective/git-object-id'
import type {
  ActionOutcome,
  EffectCertaintyResolution
} from '../../shared/fork-heimdall/effect-certainty'
import type {
  AcceptedWorkerCompletionContext,
  ExecuteContext,
  KernelAction,
  LeaseGuard
} from '../../shared/fork-heimdall/kind-contract'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { LiveSnapshot } from '../../shared/fork-heimdall/snapshot'
import {
  childTaskIdFromInstanceId,
  nodeIdFromInstanceId,
  pipelineNodeIdentity
} from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'
import type { PipelineSwarmNode } from '../../shared/fork-heimdall-pipeline/document-schema'
import type { PipelineKindWorld, PipelineReadyWorld } from './pipeline-kind-read'
import {
  dispatchAgentNode,
  isPipelineAgentReportActionKind,
  resolveAgentAttempt
} from './agent-node-executor'
import { runCheckNode } from './check-node-executor'
import { runScriptNode } from './script-node-executor'
import { expandSwarm, prepareChildWorktree } from './swarm-executor'
import { resolveObjectiveWorkspaceTarget } from '../fork-heimdall-objective/workspace-target'
import type { ObjectiveWorkspaceTarget } from '../fork-heimdall-objective/content-identity'
import { resolvePipelineChildTarget } from './pipeline-merge-source-reader'
import type { PipelineActionDispatchContext } from './pipeline-action-dispatch-contracts'
import {
  cacheWorld,
  childWorktreeFact,
  errorText,
  latestExpansion,
  nodeConfig,
  optionalText,
  record,
  runState,
  text,
  type Identity
} from './pipeline-action-identity'
import { assertRunWorkspace, composeTarget, readHead } from './pipeline-action-dispatch-workspace'
function currentChildContext(
  action: KernelAction,
  world: PipelineReadyWorld,
  ledger: WatcherLedger
): {
  swarm: PipelineSwarmNode
  taskId: string
  expansion: PipelineStoreFacts['swarmExpansions'][number]
} | null {
  const identity = pipelineNodeIdentity(action)
  const taskId = identity === null ? null : childTaskIdFromInstanceId(identity.instanceId)
  if (
    identity === null ||
    taskId === null ||
    identity.nodeId !== nodeIdFromInstanceId(identity.instanceId)
  ) {
    return null
  }
  const node = world.payload.document.nodes.find((candidate) => candidate.id === identity.nodeId)
  if (node?.type !== 'swarm' || node.worktree !== 'own') {
    return null
  }
  const state = runState(world, ledger)
  const childState = state.nodes.get(identity.instanceId)
  const swarmState = state.nodes.get(node.id)
  if (
    childState === undefined ||
    swarmState === undefined ||
    childState.epoch !== identity.epoch ||
    childState.attempt !== identity.attempt
  ) {
    return null
  }
  const expansion = latestExpansion(world.facts, node.id, swarmState.epoch)
  if (
    expansion === null ||
    !expansion.tasks.some((task) => task.id === taskId) ||
    expansion.baseCommit === null
  ) {
    return null
  }
  return { swarm: node, taskId, expansion }
}

function validCheckTimeout(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 10 && value <= 14_400
}

function isStringRecord(value: Record<string, unknown>): value is Record<string, string> {
  return Object.values(value).every((entry) => typeof entry === 'string')
}

export function createPipelineAgentActions(shared: PipelineActionDispatchContext): Readonly<{
  execute(
    action: KernelAction,
    world: PipelineReadyWorld,
    identity: Identity,
    context: ExecuteContext<PipelineKindWorld>
  ): Promise<ActionOutcome | null>
  resolveOutcome(
    attempt: AttemptEntry,
    fresh: LiveSnapshot<PipelineKindWorld>,
    identity: Identity,
    lease: LeaseGuard
  ): Promise<EffectCertaintyResolution | null>
  resolveAcceptedWorkerCompletion(
    completion: AcceptedWorkerCompletionContext
  ): Promise<EffectCertaintyResolution | null>
}> {
  const { dependencies, resolveReportContext } = shared
  const execute = async (
    action: KernelAction,
    world: PipelineReadyWorld,
    identity: Identity,
    context: ExecuteContext<PipelineKindWorld>
  ): Promise<ActionOutcome | null> => {
    switch (action.kind) {
      case 'pipeline-run-check': {
        const command = text(action, 'command')
        const timeoutSeconds = action.timeoutSeconds
        if (command === null || !validCheckTimeout(timeoutSeconds)) {
          return { effect: 'not-landed', failureClass: 'criteria', reason: 'check-action-invalid' }
        }
        try {
          const target = await resolveObjectiveWorkspaceTarget(
            dependencies.runtime,
            world.enrollment
          )
          assertRunWorkspace(world, target)
          await context.lease.assertHeld()
          const result = await runCheckNode({ command, timeoutSeconds, target })
          if (result.error !== null) {
            return { effect: 'not-landed', failureClass: 'infra', reason: result.error, result }
          }
          return result.passed
            ? { effect: 'landed', result }
            : {
                effect: 'not-landed',
                failureClass: 'criteria',
                reason: result.timedOut ? 'check-timed-out' : 'check-failed',
                result
              }
        } catch (error) {
          return { effect: 'indeterminate', failureClass: 'infra', reason: errorText(error) }
        }
      }
      case 'pipeline-run-script': {
        const command = text(action, 'command')
        const env = record(action.env)
        const configuredTimeout = action.timeoutSeconds
        const timeoutSeconds = configuredTimeout === undefined ? 1800 : configuredTimeout
        if (
          command === null ||
          env === null ||
          !isStringRecord(env) ||
          !validCheckTimeout(timeoutSeconds)
        ) {
          return { effect: 'not-landed', failureClass: 'criteria', reason: 'script-action-invalid' }
        }
        try {
          const target = await resolveObjectiveWorkspaceTarget(
            dependencies.runtime,
            world.enrollment
          )
          assertRunWorkspace(world, target)
          await context.lease.assertHeld()
          const result = await runScriptNode({ command, env, timeoutSeconds, target })
          if (result.error !== null) {
            return { effect: 'not-landed', failureClass: 'infra', reason: result.error, result }
          }
          return result.passed
            ? { effect: 'landed', result }
            : {
                effect: 'not-landed',
                failureClass: 'criteria',
                reason: result.timedOut ? 'script-timed-out' : 'script-failed',
                result
              }
        } catch (error) {
          return { effect: 'indeterminate', failureClass: 'infra', reason: errorText(error) }
        }
      }
      case 'pipeline-dispatch-agent': {
        const node = nodeConfig(world, identity)
        const spec = text(action, 'spec')
        const harness = text(action, 'agent')
        if (node === null || spec === null || harness === null) {
          return { effect: 'not-landed', failureClass: 'criteria', reason: 'agent-action-invalid' }
        }
        try {
          let target: ObjectiveWorkspaceTarget
          const taskId = childTaskIdFromInstanceId(identity.instanceId)
          const parentNode = world.payload.document.nodes.find(
            (candidate) => candidate.id === identity.nodeId
          )
          const isOwnChild =
            taskId !== null && parentNode?.type === 'swarm' && parentNode.worktree === 'own'
          const ownChild = currentChildContext(action, world, context.ledger)
          if (isOwnChild && ownChild === null) {
            return {
              effect: 'not-landed',
              failureClass: 'criteria',
              reason: 'pipeline-child-identity-stale'
            }
          }
          if (ownChild !== null) {
            const baseCommit = ownChild.expansion.baseCommit
            const task = ownChild.expansion.tasks.find(
              (candidate) => candidate.id === ownChild.taskId
            )
            if (baseCommit === null || task === undefined) {
              return {
                effect: 'not-landed',
                failureClass: 'criteria',
                reason: 'pipeline-child-expansion-stale'
              }
            }
            await context.lease.assertHeld()
            const prepared = await prepareChildWorktree(
              {
                watcherId: world.watcherId,
                repoId: world.enrollment.repoId,
                instanceId: identity.instanceId,
                epoch: identity.epoch,
                baseCommit
              },
              { runtime: dependencies.runtime, store: dependencies.pipelineStore }
            )
            const worktree = childWorktreeFact(
              dependencies.pipelineStore.facts(world.watcherId),
              identity.instanceId,
              identity.epoch
            )
            if (
              worktree === null ||
              worktree.worktreeId !== prepared.worktreeId ||
              worktree.setupState !== 'ready'
            ) {
              return {
                effect: 'indeterminate',
                failureClass: 'infra',
                reason: 'pipeline-child-worktree-record-mismatch'
              }
            }
            target = await resolvePipelineChildTarget({
              runtime: dependencies.runtime,
              enrollment: world.enrollment,
              instanceId: identity.instanceId,
              epoch: identity.epoch,
              worktreeId: worktree.worktreeId
            })
            if (target.workspacePath !== prepared.workspacePath) {
              return {
                effect: 'indeterminate',
                failureClass: 'infra',
                reason: 'pipeline-child-worktree-path-mismatch'
              }
            }
          } else {
            target = await resolveObjectiveWorkspaceTarget(dependencies.runtime, world.enrollment)
            assertRunWorkspace(world, target)
          }
          const pipelineTarget = await composeTarget(
            target,
            target.kind === 'git' ? target.gitTarget?.worktree.id : undefined
          )
          await context.lease.assertHeld()
          return await dispatchAgentNode(
            {
              watcherId: world.watcherId,
              node,
              instanceId: identity.instanceId,
              epoch: identity.epoch,
              attempt: identity.attempt,
              attemptFingerprint: makeAttemptFingerprint(
                action.contentIdentity,
                action.kind,
                action.evidenceKey
              ),
              renderedPrompt: spec,
              harness,
              ...(optionalText(action, 'model') === undefined
                ? {}
                : { model: optionalText(action, 'model') }),
              ...(optionalText(action, 'effort') === undefined
                ? {}
                : { effort: optionalText(action, 'effort') }),
              target: pipelineTarget
            },
            {
              store: dependencies.pipelineStore,
              nowMs: dependencies.nowMs,
              dispatchWorker: context.dispatchWorker
            }
          )
        } catch (error) {
          return { effect: 'indeterminate', failureClass: 'infra', reason: errorText(error) }
        }
      }
      case 'pipeline-expand-swarm': {
        try {
          await context.lease.assertHeld()
          const target = await resolveObjectiveWorkspaceTarget(
            dependencies.runtime,
            world.enrollment
          )
          assertRunWorkspace(world, target)
          const result = await expandSwarm(
            {
              watcherId: world.watcherId,
              swarmId: identity.nodeId,
              epoch: identity.epoch,
              tasks: action.tasks,
              runWorkspacePath: target.workspacePath
            },
            {
              store: dependencies.pipelineStore,
              readHead: async (workspacePath) => {
                if (workspacePath !== target.workspacePath) {
                  throw new Error('Pipeline Swarm workspace changed')
                }
                return readHead(target)
              }
            }
          )
          return result.status === 'expanded'
            ? { effect: 'landed', result: { warnings: result.warnings } }
            : {
                effect: 'not-landed',
                failureClass: 'criteria',
                reason: 'swarm-task-list-invalid',
                result: { errors: result.errors }
              }
        } catch (error) {
          return { effect: 'indeterminate', failureClass: 'infra', reason: errorText(error) }
        }
      }
      default:
        return null
    }
  }

  const resolveOutcome = async (
    attempt: AttemptEntry,
    fresh: LiveSnapshot<PipelineKindWorld>,
    identity: Identity,
    lease: LeaseGuard
  ): Promise<EffectCertaintyResolution | null> => {
    switch (attempt.action.kind) {
      case 'pipeline-dispatch-agent':
        return await resolveAgentAttempt(attempt, {
          store: dependencies.pipelineStore,
          resolveReportContext,
          nowMs: dependencies.nowMs
        })
      case 'pipeline-run-check':
      case 'pipeline-run-script':
        return { effect: 'indeterminate' }
      case 'pipeline-expand-swarm': {
        const world = cacheWorld(fresh, shared.worlds)
        if (world === null) {
          return { effect: 'indeterminate' }
        }
        const expansion = latestExpansion(
          dependencies.pipelineStore.facts(world.watcherId),
          identity.nodeId,
          identity.epoch
        )
        if (expansion === null) {
          return { effect: 'not-landed' }
        }
        if (
          !isDeepStrictEqual(expansion.tasks, attempt.action.tasks) ||
          !isObjectiveGitObjectId(expansion.baseCommit ?? '')
        ) {
          return { effect: 'indeterminate' }
        }
        try {
          await lease.assertHeld()
          const target = await resolveObjectiveWorkspaceTarget(
            dependencies.runtime,
            world.enrollment
          )
          assertRunWorkspace(world, target)
          return (await readHead(target)) === expansion.baseCommit
            ? { effect: 'landed' }
            : { effect: 'indeterminate' }
        } catch {
          return { effect: 'indeterminate', failureClass: 'infra' }
        }
      }
      default:
        return null
    }
  }

  const resolveAcceptedWorkerCompletion = async (
    completion: AcceptedWorkerCompletionContext
  ): Promise<EffectCertaintyResolution | null> => {
    if (!isPipelineAgentReportActionKind(completion.attempt.action.kind)) {
      return null
    }
    if (completion.attempt.action.kind === 'pipeline-resolve-merge-conflict') {
      return null
    }
    if (completion.attempt.dispatchId !== completion.dispatchId) {
      return { effect: 'indeterminate' }
    }
    await completion.lease.assertHeld()
    const resolution = await resolveAgentAttempt(completion.attempt, {
      store: dependencies.pipelineStore,
      resolveReportContext,
      nowMs: dependencies.nowMs
    })
    await completion.lease.assertHeld()
    return resolution
  }
  return { execute, resolveOutcome, resolveAcceptedWorkerCompletion }
}
