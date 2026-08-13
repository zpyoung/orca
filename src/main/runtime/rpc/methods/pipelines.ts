import {
  abortPipelineRun,
  listPipelineRuns,
  pausePipelineRun,
  resumePipelineRun,
  startPipelineRun,
  subscribeToPipelineRun
} from '../../pipelines/pipeline-run-lifecycle'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import {
  PipelineListRunsParams,
  PipelineRunIdParams,
  PipelineStartParams,
  PipelineSubscribeParams,
  PipelineUnsubscribeParams
} from './pipelines-schema'
import { toPipelineRunListEntry, toPipelineStartResult } from './pipelines-wire'

let pipelineSubscriptionSeq = 0

export const PIPELINE_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: 'pipeline.start',
    params: PipelineStartParams,
    handler: async (params, { runtime }) => {
      const outcome = await startPipelineRun({
        runtime,
        db: runtime.getOrchestrationDb(),
        worktreeSelector: params.worktree,
        definition: params.definition
      })
      return toPipelineStartResult(outcome)
    }
  }),
  defineMethod({
    name: 'pipeline.pause',
    params: PipelineRunIdParams,
    handler: (params, { runtime }) => pausePipelineRun(params.runId, runtime.getOrchestrationDb())
  }),
  defineMethod({
    name: 'pipeline.resume',
    params: PipelineRunIdParams,
    handler: (params, { runtime }) => resumePipelineRun(params.runId, runtime.getOrchestrationDb())
  }),
  defineMethod({
    name: 'pipeline.abort',
    params: PipelineRunIdParams,
    handler: (params, { runtime }) => abortPipelineRun(params.runId, runtime.getOrchestrationDb())
  }),
  defineMethod({
    name: 'pipeline.listRuns',
    params: PipelineListRunsParams,
    handler: (params, { runtime }) => {
      const runs = listPipelineRuns(
        runtime.getOrchestrationDb(),
        params.workspaceId ? { workspaceId: params.workspaceId } : undefined
      )
      return { runs: runs.map(toPipelineRunListEntry) }
    }
  }),
  // Why: mirrors runtime.clientEvents.subscribe (client-events.ts) — listener-first attach, then
  // replay, so nothing is missed between attach and the first emission (PipelineSnapshotPublisher
  // itself already orders attach-before-replay; this handler just relays it over the RPC stream).
  defineStreamingMethod({
    name: 'pipeline.subscribe',
    params: PipelineSubscribeParams,
    handler: async (params, { runtime, connectionId }, emit) => {
      const db = runtime.getOrchestrationDb()
      await new Promise<void>((resolve) => {
        const subscriptionId = `pipeline-subscribe-${connectionId ?? 'inproc'}-${++pipelineSubscriptionSeq}`
        const unsubscribe = subscribeToPipelineRun(db, params.runId, (snapshot) => {
          emit({ subscriptionId, ...snapshot })
        })
        runtime.registerSubscriptionCleanup(
          subscriptionId,
          () => {
            unsubscribe()
            resolve()
          },
          connectionId
        )
      })
    }
  }),
  defineMethod({
    name: 'pipeline.unsubscribe',
    params: PipelineUnsubscribeParams,
    handler: (params, { runtime, connectionId }) => {
      const expectedPrefix = `pipeline-subscribe-${connectionId ?? 'inproc'}-`
      if (!params.subscriptionId.startsWith(expectedPrefix)) {
        return { unsubscribed: false }
      }
      runtime.cleanupSubscription(params.subscriptionId)
      return { unsubscribed: true }
    }
  })
]
