import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RunRow } from '../../runtime/orchestration/db'
import { OrchestrationError } from '../../runtime/orchestration/orchestration-error'

export function answerWatcherQuestion(
  runtime: OrcaRuntimeService,
  run: RunRow,
  messageId: string,
  body: string
): void {
  const db = runtime.getOrchestrationDb()
  const question = db.getQuestion(messageId)
  if (!question || question.run_id !== run.id) {
    throw new OrchestrationError(
      'question_not_found',
      `Question ${messageId} was not found in Run ${run.id}.`
    )
  }

  const answered = db.answerQuestion({
    messageId,
    runId: run.id,
    consumerGeneration: run.consumer_generation,
    body
  })
  if (db.getFederatedDispatch(question.dispatch_id)) {
    db.enqueueFederationRelay({
      dispatchId: question.dispatch_id,
      direction: 'to_worker',
      kind: 'reply',
      payload: JSON.stringify({
        questionId: question.message_id,
        answerMessageId: answered.message.id,
        body
      })
    })
    runtime.ensureOrchestrationFederationRelay(run.id)
    return
  }
  runtime.notifyMessageArrived(`dispatch:${question.dispatch_id}`, 'status')
}
