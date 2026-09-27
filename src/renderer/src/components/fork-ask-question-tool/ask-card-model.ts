import type {
  AskPartial,
  AskRegistryResult,
  AskSpec
} from '../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { AskStatus } from '../../../../shared/fork-ask-question-tool/ask-answer-envelope'

/**
 * The normalized view-model `AskCard` renders from: the validated spec, the
 * caller's current draft (seeds initial widget state on mount), the lifecycle
 * status, and the terminal result once resolved (tech.md § C8).
 */
export type AskCardModel = {
  askId: string
  status: AskStatus
  spec: AskSpec
  partial: AskPartial
  result?: AskRegistryResult
}
