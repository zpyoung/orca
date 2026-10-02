import { getLatestAttempts } from '../../fork-heimdall/ledger-queries'
import type { AttemptEntry, WatcherLedger } from '../../fork-heimdall/ledger-types'
import { answerForAttempt, actionAttemptEffect } from './choice-rules'
import { pipelineNodeIdentity, type PipelineNodeIdentity } from './node-instance'
import type { PipelineChoice } from '../choice-types'

export type PipelineAttemptFact = {
  entry: AttemptEntry
  identity: PipelineNodeIdentity
  effect: AttemptEntry['effect']
}

export function pipelineAttemptFacts(ledger: WatcherLedger): PipelineAttemptFact[] {
  return getLatestAttempts(ledger).flatMap((entry) => {
    const identity = pipelineNodeIdentity(entry.action)
    if (identity === null) {
      return []
    }
    return [{ entry, identity, effect: actionAttemptEffect(ledger, entry) }]
  })
}

export function landedChoiceAttempts(ledger: WatcherLedger): {
  fact: PipelineAttemptFact
  choice: PipelineChoice
  comment?: string
  extendMinutes?: number
}[] {
  return pipelineAttemptFacts(ledger).flatMap((fact) => {
    if (
      (fact.entry.action.kind !== 'pipeline-pass-gate' &&
        fact.entry.action.kind !== 'pipeline-apply-choice') ||
      fact.entry.state !== 'settled' ||
      fact.effect !== 'landed'
    ) {
      return []
    }
    const answer = answerForAttempt(ledger, fact.entry)
    return answer === null
      ? []
      : [
          {
            fact,
            choice: answer.choice,
            ...(answer.comment === undefined ? {} : { comment: answer.comment }),
            ...(answer.extendMinutes === undefined ? {} : { extendMinutes: answer.extendMinutes })
          }
        ]
  })
}
