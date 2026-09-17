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
