import { runtimeApi } from '../api/runtime-bridge'
import { HEIMDALL_CHANNELS, type HeimdallApi } from '../../shared/fork-heimdall/api'

async function call<TResult>(method: string, params: unknown = {}): Promise<TResult> {
  const response = await runtimeApi.call({ method, params })
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as TResult
}

export function buildForkHeimdallApi(): HeimdallApi {
  return {
    list: () => call(HEIMDALL_CHANNELS.list),
    enroll: (input) => call(HEIMDALL_CHANNELS.enroll, input),
    disarm: (watcherId) => call(HEIMDALL_CHANNELS.disarm, { watcherId }),
    disarmAll: () => call(HEIMDALL_CHANNELS.disarmAll),
    approve: (watcherId, scope) => call(HEIMDALL_CHANNELS.approve, { watcherId, scope }),
    ledger: (watcherId) => call(HEIMDALL_CHANNELS.ledger, { watcherId }),
    debugReport: (watcherId) => call(HEIMDALL_CHANNELS.debugReport, { watcherId })
  }
}
