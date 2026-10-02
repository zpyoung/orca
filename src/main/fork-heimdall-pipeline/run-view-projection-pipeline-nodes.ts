import {
  getLatestAttempts,
  getLatestEscalations,
  sameApprovalScope
} from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import { approvalScopeForAction } from '../../shared/fork-heimdall/gate'
import type { WatcherListEntry } from '../../shared/fork-heimdall/watcher-types'
import type { PipelineEnrollmentPayload } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import {
  childTaskIdFromInstanceId,
  derivePipelineRunState,
  nodeIdFromInstanceId,
  type PipelineNodeRunState,
  type PipelineWorld
} from '../../shared/fork-heimdall-pipeline/interpreter'
import { nodeInstanceId } from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import type { PipelineStoreFacts } from '../../shared/fork-heimdall-pipeline/store-facts'
import {
  buildPipelineScriptAction,
  pipelineOutputs
} from '../../shared/fork-heimdall-pipeline/interpreter/decision-prompts'
import type { OutputMap } from '../../shared/fork-heimdall-pipeline/interpreter/decision-types'
import type { PipelineRunNodeView } from '../../shared/fork-heimdall-pipeline/run-view-types'
import {
  pipelineApprovalForNode,
  pipelineNodeTiming,
  pipelineNodeWorkerNavigation,
  type PipelineWorkerNavigationIndex
} from './run-view-projection-facts'
import {
  pipelineMergeResolverDispatchIndex,
  pipelineMergeResolverTiming,
  pipelineTurnsByInstance
} from './run-view-projection-merge'

export function projectPipelineRunNodes(input: {
  entry: WatcherListEntry
  payload: PipelineEnrollmentPayload
  ledger: WatcherLedger
  facts: PipelineStoreFacts
  nowMs: number
  unverifiableDispatchIds: ReadonlySet<string>
  workerNavigation: PipelineWorkerNavigationIndex
}): PipelineRunNodeView[] {
  const terminalNodeStates =
    input.entry.status.phase === 'terminal' ? input.facts.terminalNodeStates : undefined
  const run =
    terminalNodeStates === undefined
      ? derivePipelineRunState({
          payload: input.payload,
          ledger: input.ledger,
          facts: input.facts,
          nowMs: input.nowMs,
          unverifiableDispatchIds: input.unverifiableDispatchIds
        })
      : null
  const terminalNodeStatesByInstance =
    terminalNodeStates === undefined
      ? undefined
      : new Map(terminalNodeStates.map((node) => [node.instanceId, node] as const))
  const projectedNodes = run === null ? new Map<string, PipelineNodeRunState>() : new Map(run.nodes)
  if (terminalNodeStates !== undefined) {
    for (const node of terminalNodeStates) {
      projectedNodes.set(node.instanceId, {
        status: node.status,
        epoch: node.epoch,
        attempt: node.attempt,
        ...(node.round === undefined ? {} : { round: node.round }),
        ...(node.waitingFor === undefined ? {} : { waitingFor: node.waitingFor }),
        ...(node.phase === undefined ? {} : { phase: node.phase }),
        ...(node.revision === undefined ? {} : { revision: node.revision }),
        ...(node.progress === undefined ? {} : { progress: node.progress }),
        ...(node.warnings === undefined ? {} : { warnings: node.warnings })
      })
    }
  }
  const documentNodes = new Map(input.payload.document.nodes.map((node) => [node.id, node]))
  const attempts = getLatestAttempts(input.ledger)
  const escalations = getLatestEscalations(input.ledger)
  const mergeResolvers = pipelineMergeResolverDispatchIndex(
    input.facts,
    attempts,
    projectedNodes,
    input.ledger
  )
  const turns =
    terminalNodeStates === undefined
      ? pipelineTurnsByInstance(input.facts, input.ledger, mergeResolvers)
      : undefined
  let scriptContext: { world: PipelineWorld; outputs: OutputMap } | undefined
  return [...projectedNodes].map(([instanceId, state]) => {
    const nodeId = nodeIdFromInstanceId(instanceId)
    const taskId = childTaskIdFromInstanceId(instanceId)
    const documentNode = documentNodes.get(nodeId)
    const task = taskId
      ? input.facts.swarmExpansions
          .find((expansion) => expansion.swarmId === nodeId && expansion.epoch === state.epoch)
          ?.tasks.find((candidate) => candidate.id === taskId)
      : undefined
    let approval =
      documentNode === undefined
        ? undefined
        : pipelineApprovalForNode({
            escalations,
            attempts,
            ledger: input.ledger,
            identity: { instanceId, epoch: state.epoch, attempt: state.attempt },
            contentIdentity: `pipeline:${input.payload.pin.contentHash}`,
            node: documentNode,
            state
          })
    if (approval?.waitingFor === 'capability-approval' && documentNode?.type === 'script') {
      if (scriptContext === undefined) {
        const world: PipelineWorld = {
          watcherId: input.entry.enrollment.watcherId,
          payload: input.payload,
          facts: input.facts,
          nowMs: input.nowMs,
          hasOwner: false,
          grants: {},
          workspacePath: input.entry.enrollment.workspacePath,
          unverifiableDispatchIds: input.unverifiableDispatchIds,
          composites: {}
        }
        const outputRun =
          run ??
          derivePipelineRunState({
            payload: input.payload,
            ledger: input.ledger,
            facts: input.facts,
            nowMs: input.nowMs,
            unverifiableDispatchIds: input.unverifiableDispatchIds
          })
        scriptContext = { world, outputs: pipelineOutputs(world, outputRun) }
      }
      const scriptAction = buildPipelineScriptAction({
        world: scriptContext.world,
        node: documentNode,
        epoch: state.epoch,
        attempt: state.attempt,
        outputs: scriptContext.outputs
      })
      const escalationId = approval.escalationId
      const escalation = escalations.find((candidate) => candidate.escalationId === escalationId)
      if (
        scriptAction === null ||
        escalation?.approvalScope === undefined ||
        !sameApprovalScope(approvalScopeForAction(scriptAction), escalation.approvalScope)
      ) {
        approval = undefined
      }
    }
    // A compacted legacy run cannot substantiate transient states; only per-node terminal
    // outcomes derived from explicit ledger/store facts remain reliable without this snapshot.
    const unavailableTerminalOutcome =
      terminalNodeStates === undefined &&
      input.entry.status.phase === 'terminal' &&
      state.status !== 'done' &&
      state.status !== 'failed' &&
      state.status !== 'skipped'
    const status = unavailableTerminalOutcome
      ? 'unknown'
      : approval
        ? 'waiting'
        : state.status === 'ready'
          ? 'pending'
          : state.status
    const terminalNodeState = terminalNodeStatesByInstance?.get(instanceId)
    const timing =
      terminalNodeState === undefined
        ? pipelineMergeResolverTiming({
            nodeType: documentNode?.type,
            nodeId,
            epoch: state.epoch,
            ledger: input.ledger,
            nowMs: input.nowMs,
            baseTiming: pipelineNodeTiming({
              instanceId,
              epoch: state.epoch,
              attempt: state.attempt,
              status,
              ledger: input.ledger,
              attempts,
              facts: input.facts,
              mergeResolvers,
              nowMs: input.nowMs
            }),
            mergeResolvers
          })
        : {
            ...(terminalNodeState.startedAtMs === undefined
              ? {}
              : { startedAtMs: terminalNodeState.startedAtMs }),
            ...(terminalNodeState.elapsedMs === undefined
              ? {}
              : { elapsedMs: terminalNodeState.elapsedMs })
          }
    const workerNavigation = pipelineNodeWorkerNavigation({
      instanceId,
      nodeId,
      nodeType: documentNode?.type,
      epoch: state.epoch,
      attempt: state.attempt,
      facts: input.facts,
      attempts,
      workerNavigation: input.workerNavigation,
      mergeResolvers
    })
    return {
      instanceId,
      nodeId,
      type: documentNode?.type ?? 'unknown',
      label: task?.title ?? documentNode?.label ?? nodeId,
      status,
      waitingFor: approval?.waitingFor ?? state.waitingFor ?? null,
      ...(approval === undefined ? {} : { escalationId: approval.escalationId }),
      ...(workerNavigation === undefined ? {} : { workerNavigation }),
      epoch: state.epoch,
      attempt: state.attempt,
      ...(state.round === undefined ? {} : { round: state.round }),
      ...timing,
      turns: terminalNodeState?.turns ?? turns?.get(instanceId) ?? 0,
      ...(state.phase === undefined ? {} : { phase: state.phase }),
      ...(state.revision === undefined ? {} : { revision: state.revision }),
      ...(state.progress === undefined ? {} : { progress: state.progress }),
      ...(state.warnings === undefined
        ? {}
        : {
            warnings: state.warnings.map(
              (warning) => `${warning.code}: ${warning.taskIds.join(', ')}`
            )
          }),
      ...(taskId === null ? {} : { parentInstanceId: nodeInstanceId(nodeId), taskId })
    }
  })
}
