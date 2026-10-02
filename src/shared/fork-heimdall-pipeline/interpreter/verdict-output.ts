export type PipelineVerdictDecision = 'approve' | 'revise' | 'escalate'

export type DecodedPipelineVerdict = {
  value: unknown
  verdict: PipelineVerdictDecision
  reason?: string
  objections?: string[]
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

export function decodePipelineVerdict(value: unknown): DecodedPipelineVerdict | null {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('verdict' in value)
  ) {
    return null
  }
  const verdict = value.verdict
  if (verdict !== 'approve' && verdict !== 'revise' && verdict !== 'escalate') {
    return null
  }
  const reason = 'reason' in value ? value.reason : undefined
  if (reason !== undefined && typeof reason !== 'string') {
    return null
  }
  const objections = 'objections' in value ? value.objections : undefined
  if (objections !== undefined && !isStringArray(objections)) {
    return null
  }
  return {
    value,
    verdict,
    ...(typeof reason === 'string' ? { reason } : {}),
    ...(objections === undefined ? {} : { objections })
  }
}

export function pipelineDecisionBranchValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString()
  }
  return decodePipelineVerdict(value)?.verdict ?? null
}
