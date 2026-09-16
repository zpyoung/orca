import type { WatcherTickTrace } from '../../../shared/fork-heimdall/tick-trace'

export type DecisionTraceGroup = {
  representative: WatcherTickTrace
  oldestTrace: WatcherTickTrace
  count: number
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    )
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord)
  if (leftKeys.length !== Object.keys(rightRecord).length) {
    return false
  }
  return leftKeys.every(
    (key) => Object.hasOwn(rightRecord, key) && valuesEqual(leftRecord[key], rightRecord[key])
  )
}

function sameGateContent(left: WatcherTickTrace['gate'], right: WatcherTickTrace['gate']): boolean {
  if (left === null || right === null) {
    return left === right
  }
  switch (left.verdict) {
    case 'allow':
      return right.verdict === 'allow'
    case 'escalate':
      return right.verdict === 'escalate' && left.reason === right.reason
    case 'hold':
      return (
        right.verdict === 'hold' &&
        left.reason === right.reason &&
        valuesEqual(left.escalation?.approvalScope, right.escalation?.approvalScope)
      )
  }
}

function sameSubstantiveContent(left: WatcherTickTrace, right: WatcherTickTrace): boolean {
  // Ignore runner bookkeeping while retaining displayed semantics and complete action/scope identity.
  return (
    left.exitPath === right.exitPath &&
    left.contentIdentity === right.contentIdentity &&
    valuesEqual(left.snapshot, right.snapshot) &&
    valuesEqual(left.decision, right.decision) &&
    valuesEqual(left.declined, right.declined) &&
    sameGateContent(left.gate, right.gate) &&
    valuesEqual(left.error, right.error)
  )
}

/** Groups only adjacent tick sequences and keeps the newest full trace as the displayed card. */
export function groupDecisionTraces(
  traces: readonly WatcherTickTrace[]
): readonly DecisionTraceGroup[] {
  const sorted = [...traces].sort((left, right) => right.seq - left.seq)
  const groups: DecisionTraceGroup[] = []
  for (const trace of sorted) {
    const current = groups.at(-1)
    if (
      current &&
      current.oldestTrace.seq === trace.seq + 1 &&
      sameSubstantiveContent(current.representative, trace)
    ) {
      current.oldestTrace = trace
      current.count += 1
    } else {
      groups.push({ representative: trace, oldestTrace: trace, count: 1 })
    }
  }
  return groups
}
