import type { DispatchResult } from '../../../shared/fork-heimdall/kind-contract'

export type WorkerStartReceipt = {
  dispatchId?: string
  state?: string
  lastError?: string
}

export function parseWorkerStartReceipt(serialized: string | null): WorkerStartReceipt | null {
  if (!serialized) {
    return null
  }
  try {
    const value: unknown = JSON.parse(serialized)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null
    }
    const receipt = value as Record<string, unknown>
    if (typeof receipt.state !== 'string') {
      return null
    }
    if (receipt.dispatchId !== undefined && typeof receipt.dispatchId !== 'string') {
      return null
    }
    if (receipt.lastError !== undefined && typeof receipt.lastError !== 'string') {
      return null
    }
    return {
      state: receipt.state,
      ...(typeof receipt.dispatchId === 'string' ? { dispatchId: receipt.dispatchId } : {}),
      ...(typeof receipt.lastError === 'string' ? { lastError: receipt.lastError } : {})
    }
  } catch {
    return null
  }
}

export function dispatchResultFromReceipt(
  receipt: WorkerStartReceipt,
  requestId: string
): DispatchResult {
  if (receipt.state === 'ready' && receipt.dispatchId) {
    return { status: 'dispatched', dispatchId: receipt.dispatchId }
  }
  if (receipt.state === 'outcome_unknown' || receipt.state === 'start_unknown') {
    return { status: 'indeterminate', requestId }
  }
  return {
    status: 'refused',
    reason: 'placement-unavailable',
    detail: receipt.lastError ?? `Worker start returned state ${receipt.state ?? 'unknown'}`
  }
}
