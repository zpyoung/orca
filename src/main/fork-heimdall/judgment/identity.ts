import { createHash } from 'node:crypto'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { ObjectiveWorld } from '../../../shared/fork-heimdall-objective/detail-types'
import {
  JUDGMENT_TRUNCATION_POLICY,
  JUDGMENT_TRUNCATION_VERSION,
  projectBoundedJudgmentState,
  type JudgmentState,
  type JudgmentStateBudgetResult,
  type JudgmentTruncation,
  type JudgmentTruncationCounts
} from './state-budget'
import { stableJson } from './state-projection'
import type { JudgmentIdentity } from './store'

export { JUDGMENT_TRUNCATION_POLICY, JUDGMENT_TRUNCATION_VERSION }
export type {
  JudgmentState,
  JudgmentStateBudgetResult,
  JudgmentTruncation,
  JudgmentTruncationCounts
}

export type ComputedJudgmentIdentity = JudgmentIdentity & JudgmentStateBudgetResult

export type JudgmentIdentityOptions = { maxStateBytes?: number }

type JudgmentIdentityInternalOptions = JudgmentIdentityOptions & {
  normalize?: boolean
}

export function computeJudgmentIdentity(
  contentIdentity: string,
  world: ObjectiveWorld,
  ledger: WatcherLedger,
  options: JudgmentIdentityInternalOptions = {}
): ComputedJudgmentIdentity {
  const bounded = projectBoundedJudgmentState(contentIdentity, world, ledger, options)
  const { contentIdentity: _contentIdentity, ...projection } = bounded.state
  const projectionDigest = createHash('sha256').update(stableJson(projection)).digest('hex')
  const stateIdentity = createHash('sha256')
    .update(`${contentIdentity}\n${projectionDigest}`)
    .digest('hex')
  return {
    stateIdentity,
    contentIdentity,
    projectionDigest,
    ...bounded
  }
}
