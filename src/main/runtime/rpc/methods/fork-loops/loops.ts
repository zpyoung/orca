import { LOOPS_CHANNELS } from '../../../../../shared/fork-loops/api'
import { isTuiAgent } from '../../../../../shared/tui-agent-config'
import { requireLoopService } from '../../../../fork-loops/registration'
import { LoopStoreError } from '../../../../fork-loops/loop-database'
import { defineMethod, InvalidArgumentError } from '../../core'
import {
  LoopBindTabParamsSchema,
  LoopCreateParamsSchema,
  LoopEditParamsSchema,
  LoopIterationsParamsSchema,
  LoopListParamsSchema,
  LoopPauseParamsSchema,
  LoopQueueParamsSchema,
  LoopResumeParamsSchema,
  LoopSteerParamsSchema,
  LoopStopParamsSchema,
  LoopTargetParamsSchema
} from './loops-schemas'

/**
 * RPC surface of the loop service. Handlers rethrow the service's `LoopStoreError` untouched so
 * its `LoopErrorCode` stays on the thrown error.
 */
export const LOOPS_METHODS = [
  defineMethod({
    name: LOOPS_CHANNELS.create,
    permission: 'workspace',
    params: LoopCreateParamsSchema,
    handler: (params, { runtime }) => {
      const { agent } = params
      if (!isTuiAgent(agent)) {
        throw new InvalidArgumentError('Unsupported loop agent')
      }
      return requireLoopService(runtime).create({ ...params, agent })
    }
  }),
  defineMethod({
    name: LOOPS_CHANNELS.list,
    permission: 'workspace',
    params: LoopListParamsSchema,
    handler: (params, { runtime }) => requireLoopService(runtime).list(params)
  }),
  defineMethod({
    name: LOOPS_CHANNELS.get,
    permission: 'workspace',
    params: LoopTargetParamsSchema,
    handler: ({ loopId }, { runtime }) => {
      const snapshot = requireLoopService(runtime).get(loopId)
      if (!snapshot) {
        throw new LoopStoreError('loop_not_found', `Loop ${loopId} not found`)
      }
      return snapshot
    }
  }),
  defineMethod({
    name: LOOPS_CHANNELS.pause,
    permission: 'workspace',
    params: LoopPauseParamsSchema,
    handler: ({ loopId, mode }, { runtime }) => requireLoopService(runtime).pause(loopId, mode)
  }),
  defineMethod({
    name: LOOPS_CHANNELS.resume,
    permission: 'workspace',
    params: LoopResumeParamsSchema,
    handler: ({ loopId, addIterations }, { runtime }) =>
      requireLoopService(runtime).resume(
        loopId,
        addIterations === undefined ? {} : { addIterations }
      )
  }),
  defineMethod({
    name: LOOPS_CHANNELS.stop,
    permission: 'workspace',
    params: LoopStopParamsSchema,
    handler: ({ loopId, mode }, { runtime }) => requireLoopService(runtime).stop(loopId, mode)
  }),
  defineMethod({
    name: LOOPS_CHANNELS.steer,
    permission: 'workspace',
    params: LoopSteerParamsSchema,
    handler: ({ loopId, text }, { runtime }) => requireLoopService(runtime).steer(loopId, text)
  }),
  defineMethod({
    name: LOOPS_CHANNELS.edit,
    permission: 'workspace',
    params: LoopEditParamsSchema,
    handler: ({ loopId, patch }, { runtime }) => requireLoopService(runtime).edit(loopId, patch)
  }),
  defineMethod({
    name: LOOPS_CHANNELS.queue,
    permission: 'workspace',
    params: LoopQueueParamsSchema,
    handler: ({ loopId, op }, { runtime }) => requireLoopService(runtime).queue(loopId, op)
  }),
  defineMethod({
    name: LOOPS_CHANNELS.bindTab,
    permission: 'workspace',
    params: LoopBindTabParamsSchema,
    handler: ({ loopId, tabId, paneKey }, { runtime }) =>
      requireLoopService(runtime).bindTab(loopId, { tabId, paneKey })
  }),
  defineMethod({
    name: LOOPS_CHANNELS.detach,
    permission: 'workspace',
    params: LoopTargetParamsSchema,
    handler: ({ loopId }, { runtime }) => requireLoopService(runtime).detach(loopId)
  }),
  defineMethod({
    name: LOOPS_CHANNELS.openTab,
    permission: 'workspace',
    params: LoopTargetParamsSchema,
    handler: ({ loopId }, { runtime }) => requireLoopService(runtime).openTab(loopId)
  }),
  defineMethod({
    name: LOOPS_CHANNELS.iterations,
    permission: 'workspace',
    params: LoopIterationsParamsSchema,
    handler: ({ loopId, limit }, { runtime }) =>
      requireLoopService(runtime).listIterations(loopId, limit === undefined ? {} : { limit })
  })
]
