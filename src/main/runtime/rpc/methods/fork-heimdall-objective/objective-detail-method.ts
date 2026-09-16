import { defineMethod, type RpcAnyMethod } from '../../core'
import { HEIMDALL_CHANNELS } from '../../../../../shared/fork-heimdall/api'
import { WatcherTargetSchema } from '../../../../../shared/fork-heimdall/fleet-types'
import { ObjectiveDetailSchema } from '../../../../../shared/fork-heimdall-objective/detail-types'
import { ObjectiveEnrollmentPayloadSchema } from '../../../../../shared/fork-heimdall-objective/contract-types'
import { createFleetEnvironmentTransport } from '../../../../fork-heimdall/fleet-environment-transport'
import { requireHeimdallKernel } from '../fork-heimdall/kernel-binding'
import { getCanonicalUserDataPath } from '../../../../persistence'
import { requireHeimdallObjectiveStore } from './objective-binding'
import { ObjectiveDetailReaderSchema } from './objective-detail-reader-schema'

async function readLocalObjectiveDetail(runtime: object, watcherId: string) {
  const target = { watcherId, connectionId: null, pairingRevision: null } as const
  const detail = await requireHeimdallKernel(runtime).detail(target)
  if (detail.watcher.entry.enrollment.kind !== 'objective') {
    throw new Error('Requested Heimdall watcher is not an objective')
  }
  const contract = ObjectiveEnrollmentPayloadSchema.parse(
    detail.watcher.entry.enrollment.kindPayload
  )
  return requireHeimdallObjectiveStore(runtime).detail(watcherId, contract, detail.ledger)
}

async function readRemoteObjectiveDetail(target: {
  watcherId: string
  connectionId: string
  pairingRevision: number
}) {
  const environments = createFleetEnvironmentTransport(getCanonicalUserDataPath)
  const response = await environments.read(
    { id: target.connectionId, pairingRevision: target.pairingRevision },
    HEIMDALL_CHANNELS.objectiveDetail,
    { watcherId: target.watcherId, connectionId: null, pairingRevision: null }
  )
  if (response.ok !== true) {
    throw new Error(
      `The owning runtime refused the objective detail read: ${response.error.message}`
    )
  }
  return ObjectiveDetailReaderSchema.parse(response.result)
}

export const HEIMDALL_OBJECTIVE_METHODS: readonly RpcAnyMethod[] = [
  defineMethod({
    name: HEIMDALL_CHANNELS.objectiveDetail,
    params: WatcherTargetSchema,
    handler: async (target, { runtime, clientKind }) => {
      if (clientKind === 'runtime') {
        if (target.connectionId !== null || target.pairingRevision !== null) {
          throw new Error('A remote runtime can only serve locally owned Heimdall objectives')
        }
        return ObjectiveDetailSchema.parse(
          await readLocalObjectiveDetail(runtime, target.watcherId)
        )
      }
      if (target.connectionId === null) {
        return ObjectiveDetailSchema.parse(
          await readLocalObjectiveDetail(runtime, target.watcherId)
        )
      }
      return readRemoteObjectiveDetail({
        watcherId: target.watcherId,
        connectionId: target.connectionId,
        pairingRevision: target.pairingRevision!
      })
    }
  })
]
