import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { AskAnswers } from '../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import { isTerminalAskStatus } from '../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type { AskPartial } from '../../../../shared/fork-ask-question-tool/ask-question-schema'
import type { AskCardModel } from './ask-card-model'
import { initialDraftFor, draftsToPartial, type AskQuestionDraft } from './ask-question-draft'
import { buildAskSubmission } from './build-ask-submission'
import { AskQuestionFrame } from './AskQuestionFrame'
import { AskFieldControl } from './AskFieldControl'
import { AskCollapsedSummary } from './AskCollapsedSummary'

export type AskCardProps = {
  model: AskCardModel
  onSubmit: (answers: AskAnswers, skipped: string[]) => void
  onCancel: () => void
  /** Whether the submitted answer is still being delivered to the agent. */
  isSubmitting?: boolean
  /** Fires with the normalized partial on every draft change; callers own debouncing the send. */
  onDraftChange?: (partial: AskPartial) => void
}

function buildInitialDrafts(model: AskCardModel): Record<string, AskQuestionDraft> {
  return Object.fromEntries(
    model.spec.questions.map((question) => [question.id, initialDraftFor(model.partial[question.id])])
  )
}

/**
 * Renders an agent's ask as an editable form (props in, answers out) or, once
 * resolved, a read-only summary. Callers own docking and identify each ask by
 * mounting with `key={model.askId}` — this component keeps its own draft
 * state for the lifetime of the mount and does not reset it on prop changes.
 */
export function AskCard({
  model,
  onSubmit,
  onCancel,
  isSubmitting = false,
  onDraftChange
}: AskCardProps): React.JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, AskQuestionDraft>>(() => buildInitialDrafts(model))
  const [errors, setErrors] = useState<Record<string, string>>({})

  if (isTerminalAskStatus(model.status) && model.result) {
    return <AskCollapsedSummary status={model.status} result={model.result} />
  }

  const updateDraft = (questionId: string, next: AskQuestionDraft): void => {
    const updated = { ...drafts, [questionId]: next }
    setDrafts(updated)
    onDraftChange?.(draftsToPartial(updated))
    setErrors((prev) => {
      if (!(questionId in prev)) {
        return prev
      }
      const next = { ...prev }
      delete next[questionId]
      return next
    })
  }

  const handleSubmit = (): void => {
    const submission = buildAskSubmission(model.spec.questions, drafts)
    if (!submission.ok) {
      setErrors(submission.errors)
      return
    }
    onSubmit(submission.answers, submission.skipped)
  }

  return (
    <div className="overflow-hidden rounded-lg border border-input bg-card shadow-xs">
      <div className="divide-y divide-border/60">
        {model.spec.questions.map((question) => (
          <AskQuestionFrame key={question.id} question={question} error={errors[question.id]}>
            <AskFieldControl
              question={question}
              draft={drafts[question.id]!}
              onChange={(next) => updateDraft(question.id, next)}
              disabled={isSubmitting}
              invalid={Boolean(errors[question.id])}
            />
          </AskQuestionFrame>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border p-3">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={isSubmitting}>
          {translate('components.fork-ask-question-tool.askCard.cancel', 'Cancel')}
        </Button>
        <Button type="button" onClick={handleSubmit} disabled={isSubmitting}>
          {isSubmitting
            ? translate('components.fork-ask-question-tool.askCard.submitting', 'Submitting…')
            : translate('components.fork-ask-question-tool.askCard.submit', 'Submit')}
        </Button>
      </div>
    </div>
  )
}
