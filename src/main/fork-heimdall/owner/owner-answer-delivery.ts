import type { Deviation } from '../../../shared/fork-heimdall/owner/deviation'
import type { AnswerWorkerIntervention } from '../../../shared/fork-heimdall/owner/intervention'
import { getErrorCode } from '../../git/worktree-operation-options'
import type { WatcherQuestionState } from '../orchestration/orchestration-contract'
import { classifyOwnerAnswerTarget, type OwnerAnswerTarget } from '../question-resolution'

const REFUSED_ANSWER_CODES: ReadonlySet<string> = new Set([
  'question-already-answered',
  'question_not_found',
  'dispatch_inactive',
  'answer_conflict'
])

const ESCALATION_ANSWER_REFUSAL =
  'answer-worker: this deviation is a worker escalation, which has no question thread to answer.' +
  ' Respond with continue, stop-worker, ask-human, or abandon.'

export type OwnerAnswerDelivery =
  | { status: 'delivered' }
  | Exclude<OwnerAnswerTarget, { status: 'deliver' }>

/**
 * Delivers an owner's answer-worker move, turning every deterministic orchestration refusal into a
 * `refuse` the owner can correct. Only errors that say nothing about the answer itself propagate.
 */
export async function deliverOwnerAnswer(args: {
  deviation: Deviation
  move: AnswerWorkerIntervention
  readQuestion(messageId: string): Promise<WatcherQuestionState>
  answerQuestion(messageId: string, answer: string): Promise<void>
}): Promise<OwnerAnswerDelivery> {
  if (args.deviation.kind === 'worker-escalation') {
    return { status: 'refuse', reason: ESCALATION_ANSWER_REFUSAL }
  }
  const target = classifyOwnerAnswerTarget(
    args.move.messageId,
    await args.readQuestion(args.move.messageId)
  )
  if (target.status !== 'deliver') {
    return target
  }
  try {
    await args.answerQuestion(args.move.messageId, args.move.answer)
  } catch (error) {
    // the thread can change between the read and the write, so the write's refusal is authoritative
    if (error instanceof Error && REFUSED_ANSWER_CODES.has(getErrorCode(error) ?? '')) {
      return { status: 'refuse', reason: `answer-worker: ${error.message}` }
    }
    throw error
  }
  return { status: 'delivered' }
}
