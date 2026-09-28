import type {
  AskAnswer,
  AskResultBody
} from '../../../shared/fork-ask-question-tool/ask-answer-envelope'
import { MAX_ASK_OPTIONS } from '../../../shared/fork-ask-question-tool/ask-question-field-validation'
import {
  MAX_ASK_QUESTIONS,
  validateAskSpec,
  type AskQuestion,
  type AskSpec
} from '../../../shared/fork-ask-question-tool/ask-question-schema'
import {
  claudePromptQuestions,
  isClaudePromptRecord,
  readClaudePromptString
} from '../../claude/claude-prompt-registry'

export const NO_OWNER_ANSWER = 'No answer from the watcher owner; proceed with your best judgment.'

/** One native question and the ask question that carries it; `providerKey` is what the native reply is keyed by. */
export type NativeQuestionBinding = {
  askQuestionId: string
  providerKey: string
  multiple: boolean
}

export type NativeQuestionConversion =
  | { ok: true; spec: AskSpec; bindings: NativeQuestionBinding[] }
  | { ok: false; reason: string; exceedsAskCapacity?: true }

type NativeOption = { label: string; description?: string }

type NativeQuestion = {
  providerKey: string
  text: string
  header: string | null
  options: NativeOption[]
  multiple: boolean
}

// Synthetic option values: provider labels may contain commas (the multiselect reply separator)
// or credential-shaped words that ask-spec validation refuses as values but allows as labels.
function toAskQuestion(question: NativeQuestion, askQuestionId: string): AskQuestion {
  const common = {
    id: askQuestionId,
    ...(question.header ? { header: question.header } : {})
  }
  if (question.options.length === 0) {
    return { ...common, type: 'text', question: question.text }
  }
  if (question.options.length > MAX_ASK_OPTIONS) {
    const listed = question.options.map((option) => option.label).join('; ')
    return { ...common, type: 'text', question: `${question.text}\n\nOptions: ${listed}` }
  }
  return {
    ...common,
    type: question.multiple ? 'multiselect' : 'select',
    question: question.text,
    options: question.options.map((option, index) => ({
      value: `o${index + 1}`,
      label: option.label,
      ...(option.description ? { description: option.description } : {})
    }))
  }
}

function convertNativeQuestions(questions: NativeQuestion[]): NativeQuestionConversion {
  if (questions.length === 0) {
    return { ok: false, reason: 'the request carries no questions' }
  }
  if (questions.length > MAX_ASK_QUESTIONS) {
    return {
      ok: false,
      reason: `at most ${MAX_ASK_QUESTIONS} questions can be relayed at once`,
      exceedsAskCapacity: true
    }
  }
  const bindings = questions.map((question, index) => ({
    askQuestionId: `q${index + 1}`,
    providerKey: question.providerKey,
    multiple: question.multiple
  }))
  const validation = validateAskSpec({
    questions: questions.map((question, index) => toAskQuestion(question, `q${index + 1}`))
  })
  if (!validation.ok) {
    return {
      ok: false,
      reason: validation.errors.map((error) => `${error.path}: ${error.message}`).join('; ')
    }
  }
  return { ok: true, spec: validation.spec, bindings }
}

function readNativeOptions(raw: unknown): NativeOption[] {
  if (!Array.isArray(raw)) {
    return []
  }
  const options: NativeOption[] = []
  for (const entry of raw) {
    if (!isClaudePromptRecord(entry) || entry.isOther === true) {
      continue
    }
    const label = readClaudePromptString(entry.label)
    const description = readClaudePromptString(entry.description)
    if (label) {
      options.push({ label, ...(description ? { description } : {}) })
    }
  }
  return options
}

/** Claude `AskUserQuestion` input as an ask spec, keyed the way Claude reads `answers` back. */
export function claudeQuestionsToAskSpec(input: Record<string, unknown>): NativeQuestionConversion {
  return convertNativeQuestions(
    claudePromptQuestions(input).map((question, index) => {
      const text = readClaudePromptString(question.question)
      const header = readClaudePromptString(question.header)
      return {
        providerKey: text ?? header ?? `question-${index + 1}`,
        text: text ?? header ?? `Question ${index + 1}`,
        header,
        options: readNativeOptions(question.options),
        multiple: question.multiSelect === true
      }
    })
  )
}

/** Codex `item/tool/requestUserInput` params as an ask spec; secret questions are refused, never relayed. */
export function codexParamsToAskSpec(params: unknown): NativeQuestionConversion {
  const record = isClaudePromptRecord(params) ? params : {}
  const raw = Array.isArray(record.questions) ? record.questions.filter(isClaudePromptRecord) : []
  // Only questions with an id are ones Codex's prompt registry tracks and accepts answers for.
  const questions = raw.flatMap((question) => {
    const id = typeof question.id === 'string' && question.id.length > 0 ? question.id : null
    return id ? [{ id, question }] : []
  })
  if (questions.some(({ question }) => question.isSecret === true)) {
    return { ok: false, reason: 'secret input cannot be relayed to the watcher owner' }
  }
  return convertNativeQuestions(
    questions.map(({ id, question }) => {
      const text = readClaudePromptString(question.question)
      const header = readClaudePromptString(question.header)
      return {
        providerKey: id,
        text: text ?? header ?? id,
        header,
        options: readNativeOptions(question.options),
        multiple: false
      }
    })
  )
}

function answerTexts(answer: AskAnswer | undefined): string[] {
  if (!answer) {
    return []
  }
  if ('values' in answer) {
    return [...answer.labels, ...(answer.other ? [answer.other] : [])]
  }
  if ('label' in answer && answer.label) {
    return [answer.label]
  }
  return [String(answer.value)]
}

function boundAnswerTexts(binding: NativeQuestionBinding, result: AskResultBody): string[] {
  const texts = answerTexts(result.answers[binding.askQuestionId])
  return texts.length > 0 ? texts : [NO_OWNER_ANSWER]
}

/** Claude's `answers` map: keyed by question text, labels for chosen options, an array for multi-select. */
export function askResultToClaudeAnswers(
  bindings: NativeQuestionBinding[],
  result: AskResultBody
): Record<string, string | string[]> {
  const answers: Record<string, string | string[]> = {}
  for (const binding of bindings) {
    const texts = boundAnswerTexts(binding, result)
    answers[binding.providerKey] = binding.multiple ? texts : texts.join(', ')
  }
  return answers
}

/** One answer string per Codex question id; Codex takes a single answer per question. */
export function askResultToCodexAnswers(
  bindings: NativeQuestionBinding[],
  result: AskResultBody
): Record<string, string> {
  const answers: Record<string, string> = {}
  for (const binding of bindings) {
    answers[binding.providerKey] = boundAnswerTexts(binding, result).join(', ')
  }
  return answers
}
