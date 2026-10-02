import { getLatestAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { PipelineRunState } from '../../shared/fork-heimdall-pipeline/interpreter'
import { nodeIdFromInstanceId } from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import type { PipelineTerminalNodeState } from '../../shared/fork-heimdall-pipeline/store-facts'
import type { PipelineReadyWorld } from './pipeline-kind-read'
import { pipelineNodeTiming } from './run-view-projection-facts'
import {
  pipelineMergeResolverDispatchIndex,
  pipelineMergeResolverTiming,
  pipelineTurnsByInstance
} from './run-view-projection-merge'

/** Captures per-node outcomes and graph counters from the pre-compaction run facts. */
export function captureTerminalRunNodeStates(
  world: PipelineReadyWorld,
  ledger: WatcherLedger,
  run: PipelineRunState
): PipelineTerminalNodeState[] {
  const attempts = getLatestAttempts(ledger)
  const mergeResolvers = pipelineMergeResolverDispatchIndex(
    world.facts,
    attempts,
    run.nodes,
    ledger
  )
  const turns = pipelineTurnsByInstance(world.facts, ledger, mergeResolvers)
  const documentNodes = new Map(world.payload.document.nodes.map((node) => [node.id, node]))
  return [...run.nodes].map(([instanceId, node]) => {
    const nodeId = nodeIdFromInstanceId(instanceId)
    const documentNode = documentNodes.get(nodeId)
    const baseTiming = pipelineNodeTiming({
      instanceId,
      epoch: node.epoch,
      attempt: node.attempt,
      status: node.status === 'ready' ? 'pending' : node.status,
      ledger,
      attempts,
      facts: world.facts,
      mergeResolvers,
      nowMs: world.nowMs
    })
    const timing = pipelineMergeResolverTiming({
      nodeType: documentNode?.type,
      nodeId,
      epoch: node.epoch,
      ledger,
      nowMs: world.nowMs,
      baseTiming,
      mergeResolvers
    })
    return {
      instanceId,
      status: node.status,
      epoch: node.epoch,
      attempt: node.attempt,
      ...(node.round === undefined ? {} : { round: node.round }),
      ...(node.waitingFor === undefined ? {} : { waitingFor: node.waitingFor }),
      ...(node.phase === undefined ? {} : { phase: node.phase }),
      ...(node.revision === undefined ? {} : { revision: node.revision }),
      ...(node.progress === undefined ? {} : { progress: node.progress }),
      ...(node.warnings === undefined ? {} : { warnings: node.warnings }),
      ...(timing.startedAtMs === undefined ? {} : { startedAtMs: timing.startedAtMs }),
      ...(timing.elapsedMs === undefined ? {} : { elapsedMs: timing.elapsedMs }),
      turns: turns.get(instanceId) ?? 0
    }
  })
}
