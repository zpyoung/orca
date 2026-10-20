import type { ApprovalScope } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherCommand } from '../../shared/fork-heimdall/fleet-types'
import { PipelineChoiceSchema } from '../../shared/fork-heimdall-pipeline/choice-types'
import { getOptionalPositiveIntegerFlag, getOptionalStringFlag } from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { requireAnswerText } from '../fork-heimdall/watcher-command-values'

const PIPELINE_CHOICE_ACTION_KINDS: Record<string, true> = {
  'pipeline-pass-gate': true,
  'pipeline-apply-choice': true
}

export type PipelineChoiceAnswerCommand = Extract<
  WatcherCommand,
  { kind: 'answer-pipeline-choice' }
>

export function pipelineChoiceAnswerCommand(
  scope: ApprovalScope,
  flags: Map<string, string | boolean>
): PipelineChoiceAnswerCommand | null {
  const choiceFlag = getOptionalStringFlag(flags, 'choice')
  if (!Object.hasOwn(PIPELINE_CHOICE_ACTION_KINDS, scope.actionKind)) {
    if (choiceFlag !== undefined && choiceFlag !== 'approve') {
      throw new RuntimeClientError(
        'invalid_argument',
        '--choice is supported only for pipeline gates and choices.'
      )
    }
    return null
  }

  const choiceResult = PipelineChoiceSchema.safeParse(choiceFlag ?? 'approve')
  if (!choiceResult.success) {
    throw new RuntimeClientError('invalid_argument', `Invalid pipeline choice "${choiceFlag}".`)
  }
  const commentFlag = getOptionalStringFlag(flags, 'comment')
  const comment =
    commentFlag === undefined ? undefined : requireAnswerText(commentFlag, 'comment', 4_000)
  const extendMinutes = getOptionalPositiveIntegerFlag(flags, 'extend-minutes')
  if (extendMinutes !== undefined && extendMinutes > 1_440) {
    throw new RuntimeClientError('invalid_argument', '--extend-minutes must be from 1 to 1440.')
  }
  if (choiceResult.data === 'send-back' && comment === undefined) {
    throw new RuntimeClientError('invalid_argument', '--choice send-back requires --comment.')
  }
  if (choiceResult.data === 'extend' && extendMinutes === undefined) {
    throw new RuntimeClientError('invalid_argument', '--choice extend requires --extend-minutes.')
  }
  return {
    kind: 'answer-pipeline-choice',
    scope,
    choice: choiceResult.data,
    ...(comment === undefined ? {} : { comment }),
    ...(extendMinutes === undefined ? {} : { extendMinutes })
  }
}
