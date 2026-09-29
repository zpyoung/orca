import type {
  JudgmentAnswer,
  JudgmentQuestionRequest
} from '../../../shared/fork-heimdall/judgment/types'
import { JudgmentClientFailure, JudgmentResponseSchema, type JudgmentResponse } from './client'
import {
  JudgmentUnavailableReasonSchema,
  type JudgmentUnavailableReason
} from './answer-validation'

type MalformedResponseReason =
  | 'invalid-json'
  | 'invalid-utf8'
  | 'invalid-envelope'
  | 'unexpected-answer'

type ValidatedClientResponse = {
  model: JudgmentResponse['model']
  answers: Map<string, JudgmentAnswer>
  unavailable: Map<string, JudgmentUnavailableReason>
}

function rejectMalformedResponse(reason: MalformedResponseReason): never {
  throw new JudgmentClientFailure('Judgment response is invalid', {
    code: 'malformed-response',
    reason
  })
}

export function validateClientResponse(
  value: unknown,
  requests: readonly JudgmentQuestionRequest[]
): ValidatedClientResponse {
  const parsedResponse = JudgmentResponseSchema.safeParse(value)
  if (!parsedResponse.success) {
    return rejectMalformedResponse('invalid-envelope')
  }

  const response = parsedResponse.data
  const unavailable = response.unavailable ?? {}
  const requestedIds = new Set(requests.map((request) => request.id))
  if (
    [...Object.keys(response.answers), ...Object.keys(unavailable)].some(
      (id) => !requestedIds.has(id)
    )
  ) {
    return rejectMalformedResponse('unexpected-answer')
  }

  const answers = new Map<string, JudgmentAnswer>()
  const unavailableById = new Map<string, JudgmentUnavailableReason>()
  for (const request of requests) {
    const hasAnswer = Object.hasOwn(response.answers, request.id)
    const hasUnavailable = Object.hasOwn(unavailable, request.id)
    if (hasAnswer === hasUnavailable) {
      return rejectMalformedResponse('invalid-envelope')
    }
    if (hasAnswer) {
      answers.set(request.id, response.answers[request.id]!)
    } else {
      unavailableById.set(request.id, unavailable[request.id]!)
    }
  }
  return { model: response.model, answers, unavailable: unavailableById }
}

export function partialResponseReason(
  validCount: number,
  totalCount: number,
  unavailable: ReadonlyMap<string, JudgmentUnavailableReason>
): string {
  const counts = new Map<JudgmentUnavailableReason, number>()
  for (const reason of unavailable.values()) {
    counts.set(reason, (counts.get(reason) ?? 0) + 1)
  }
  const summary = JudgmentUnavailableReasonSchema.options.flatMap((reason) => {
    const count = counts.get(reason)
    return count === undefined ? [] : [`${reason}=${count}`]
  })
  return [
    `judgment unavailable: partial-response; valid=${validCount}/${totalCount};`,
    `unavailable=${summary.join(',')}`
  ].join(' ')
}
