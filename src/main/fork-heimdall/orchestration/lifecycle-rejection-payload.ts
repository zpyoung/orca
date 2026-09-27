export type ParsedLifecycleRejection = {
  code: string
  reason: string
  originalBody?: string
}

export function parseLifecycleRejectionPayload(
  payload: Record<string, unknown>
): ParsedLifecycleRejection | null {
  const marker = payload._orcaLifecycleRejection
  if (!marker || typeof marker !== 'object') {
    return null
  }
  const rejection = marker as Record<string, unknown>
  const reason =
    typeof rejection.originalReason === 'string'
      ? rejection.originalReason
      : typeof rejection.reason === 'string'
        ? rejection.reason
        : null
  if (typeof rejection.code !== 'string' || !rejection.code.trim() || reason === null) {
    return null
  }
  return {
    code: rejection.code,
    reason,
    ...(typeof rejection.originalBody === 'string' ? { originalBody: rejection.originalBody } : {})
  }
}
