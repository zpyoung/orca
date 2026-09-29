import { JudgmentClientFailure } from './client'

const GENERIC_EVALUATION_FAILURE_REASON = 'judgment unavailable: evaluation failed'

export function evaluationFailureReason(error: unknown): string {
  if (!(error instanceof JudgmentClientFailure)) {
    return GENERIC_EVALUATION_FAILURE_REASON
  }

  const diagnostic = error.diagnostic
  switch (diagnostic.code) {
    case 'timeout':
      return 'judgment unavailable: timeout'
    case 'network-error':
      return 'judgment unavailable: network-error'
    case 'http-status':
      return Number.isInteger(diagnostic.status) &&
        diagnostic.status >= 100 &&
        diagnostic.status <= 599
        ? `judgment unavailable: http-status:${diagnostic.status}`
        : GENERIC_EVALUATION_FAILURE_REASON
    case 'retry-exhausted':
      return diagnostic.status === 429 || diagnostic.status === 529
        ? `judgment unavailable: retry-exhausted:${diagnostic.status}`
        : GENERIC_EVALUATION_FAILURE_REASON
    case 'state-size':
      return 'judgment unavailable: state-size'
    case 'request-size':
      return 'judgment unavailable: request-size'
    case 'response-size':
      return 'judgment unavailable: response-size'
    case 'malformed-response':
      if (
        diagnostic.reason === 'invalid-json' ||
        diagnostic.reason === 'invalid-utf8' ||
        diagnostic.reason === 'invalid-envelope' ||
        diagnostic.reason === 'unexpected-answer'
      ) {
        return `judgment unavailable: malformed-response:${diagnostic.reason}`
      }
      return 'judgment unavailable: malformed-response'
    case 'unknown':
      return GENERIC_EVALUATION_FAILURE_REASON
  }
}
