import type { AskPartialQuestionDraft } from '../../../../shared/fork-ask-question-tool/ask-question-schema'

/** Local widget state for one question, keyed by question id in `AskCard`. */
export type AskQuestionDraft = {
  /** Option `value`s currently picked (0 or 1 for `select`, 0..n for `multiselect`). */
  selected: string[]
  /** Free text: the escape hatch when no option is picked, or a note alongside one. */
  freeText: string
  /** Raw input for `text` / `number` / `date`; parsed against the question's domain on submit. */
  text: string
  confirm: boolean | null
}

export function initialDraftFor(partial: AskPartialQuestionDraft | undefined): AskQuestionDraft {
  return {
    selected: partial?.selected ?? [],
    freeText: (partial?.selected?.length ? partial.note : partial?.other) ?? '',
    text: partial?.draft ?? '',
    confirm: partial?.confirm ?? null
  }
}
