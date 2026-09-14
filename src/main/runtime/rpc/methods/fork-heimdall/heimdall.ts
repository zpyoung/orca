import { defineMethod, type RpcAnyMethod } from '../../core'
import {
  HEIMDALL_CHANNELS,
  EnrollInputSchema,
  WatcherIdRequestSchema,
  ApproveRequestSchema,
  EmptyHeimdallRequestSchema
} from '../../../../../shared/fork-heimdall/api'
import { requireHeimdallKernel } from './kernel-binding'

export const HEIMDALL_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: HEIMDALL_CHANNELS.list,
    params: EmptyHeimdallRequestSchema,
    handler: (_params, { runtime }) => requireHeimdallKernel(runtime).list()
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.enroll,
    params: EnrollInputSchema,
    handler: async (params, { runtime }) => {
      const result = await requireHeimdallKernel(runtime).enroll(params)
      if (result.status === 'refused') {
        throw new Error(`Heimdall enrollment refused: ${result.reason}`)
      }
      return result
    }
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.disarm,
    params: WatcherIdRequestSchema,
    handler: ({ watcherId }, { runtime }) => requireHeimdallKernel(runtime).disarm(watcherId)
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.disarmAll,
    params: EmptyHeimdallRequestSchema,
    handler: (_params, { runtime }) => requireHeimdallKernel(runtime).disarmAll()
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.approve,
    params: ApproveRequestSchema,
    handler: ({ watcherId, scope }, { runtime }) =>
      requireHeimdallKernel(runtime).approve(watcherId, scope)
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.ledger,
    params: WatcherIdRequestSchema,
    handler: ({ watcherId }, { runtime }) => requireHeimdallKernel(runtime).ledger(watcherId)
  }),
  defineMethod({
    name: HEIMDALL_CHANNELS.debugReport,
    params: WatcherIdRequestSchema,
    handler: ({ watcherId }, { runtime }) => requireHeimdallKernel(runtime).debugReport(watcherId)
  })
]
