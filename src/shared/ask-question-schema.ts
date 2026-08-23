import type { AskAnswers, AskStatus } from './ask-answer-envelope'

export type AskPreviewFormat = 'markdown' | 'html'
export type AskPreview = { format: AskPreviewFormat; content: string }
export type AskOption = { value: string; label: string; description?: string; preview?: AskPreview }

type AskQuestionCommon = { id: string; question: string; header?: string; required?: boolean }

export type AskSelectQuestion = AskQuestionCommon & { type: 'select'; options: AskOption[]; default?: string }
export type AskMultiselectQuestion = AskQuestionCommon & {
  type: 'multiselect'
  options: AskOption[]
  default?: string[]
}
export type AskTextQuestion = AskQuestionCommon & {
  type: 'text'
  multiline?: boolean
  pattern?: string
  format?: 'email' | 'url'
  default?: string
}
export type AskNumberQuestion = AskQuestionCommon & {
  type: 'number'
  integer?: boolean
  min?: number
  max?: number
  default?: number
}
/** `default`, when present, is an ISO 8601 calendar date (`YYYY-MM-DD`). */
export type AskDateQuestion = AskQuestionCommon & { type: 'date'; default?: string }
export type AskConfirmQuestion = AskQuestionCommon & { type: 'confirm'; default?: boolean }

export type AskQuestion =
  | AskSelectQuestion
  | AskMultiselectQuestion
  | AskTextQuestion
  | AskNumberQuestion
  | AskDateQuestion
  | AskConfirmQuestion

/** Flat question set for one `orca ask` invocation; no conditional branching (logic.md § Question schema). */
export type AskSpec = { questions: AskQuestion[] }

export type AskValidationError = { path: string; message: string }
export type AskSpecValidationResult =
  | { ok: true; spec: AskSpec }
  | { ok: false; errors: AskValidationError[] }

/**
 * Per-question normalized drafts, persisted in `partial_json` and carried by
 * `ask.updatePartial` (tech.md § Data models). Never raw widget state.
 */
export type AskPartialQuestionDraft = {
  selected?: string[]
  other?: string
  draft?: string
  confirm?: boolean
  note?: string
}
export type AskPartial = Record<string, AskPartialQuestionDraft>

/** The terminal envelope body embedded in a registry event's `result` (tech.md § Data models). */
export type AskRegistryResult = { answers: AskAnswers; skipped: string[]; summary: string }

/** One row of registry state pushed to clients via `ask.snapshot` / `ask.subscribe` / IPC. */
export type AskRegistryEvent = {
  seq: number
  epoch: string
  askId: string
  paneKey: string | null
  status: AskStatus
  spec?: AskSpec
  partial?: AskPartial
  result?: AskRegistryResult
}

/** `ask.subscribe`'s frame union; `type` is the discriminator (tech.md § Data models). */
export type AskStreamFrame =
  | { type: 'snapshot'; event: AskRegistryEvent }
  | { type: 'watermark'; seq: number; epoch: string }
  | { type: 'event'; event: AskRegistryEvent }
  | { type: 'end'; reason: 'epoch_changed' | 'closed' }

/** Default `ask.wait` chunk size (tech.md § C5: `orca ask` register → wait loop). */
export const ASK_DEFAULT_CHUNK_MS = 100_000

// New ask-only constant: mirrors resolveOrchestrationAskClientTimeoutMs's chunk+grace shape
// without reusing orchestration-ask-timeout.ts's constants (tech.md C5, DO-NOT-CHANGE #3).
export const ASK_CHUNK_CLIENT_GRACE_MS = 5_000

/** Client-side RPC timeout for one `ask.wait` chunk: the chunk budget plus network/keepalive grace. */
export function resolveAskWaitClientTimeoutMs(chunkMs: number | undefined): number {
  return (chunkMs === undefined ? ASK_DEFAULT_CHUNK_MS : chunkMs) + ASK_CHUNK_CLIENT_GRACE_MS
}

const MAX_QUESTIONS = 10
const MAX_OPTIONS = 12
const QUESTION_TYPES = new Set(['select', 'multiselect', 'text', 'number', 'date', 'confirm'])
const CREDENTIAL_PATTERN = /\b(pass(word|phrase)?|secret|token|api\s?key|credential|private\s?key)\b/i

// `\b` cannot fire across `_` (it's a word character), so prefixed snake_case ids like
// db_password would otherwise slip the check; normalize separators and case humps to real
// word boundaries before matching (tech.md C1 REGEX: credential refusal).
const normalizeCredentialCandidate = (value: string): string => value.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2')
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const FORMAT_PATTERNS: Record<'email' | 'url', RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  url: /^[a-z][a-z0-9+.-]*:\/\/\S+$/i
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

function isValidIsoDate(value: string): boolean {
  return ISO_DATE_PATTERN.test(value) && !Number.isNaN(new Date(`${value}T00:00:00.000Z`).getTime())
}

function checkOptional<T>(raw: unknown, isValid: (value: unknown) => value is T, path: string, message: string, errors: AskValidationError[]): T | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!isValid(raw)) {
    errors.push({ path, message })
    return undefined
  }
  return raw
}

/**
 * Validates arbitrary parsed JSON against the ask spec contract (tech.md § C1). Pure, no I/O,
 * and never throws — every rejection reason surfaces as a field-path error instead. The
 * returned `spec` is only meaningful when `ok` is true; per-question validators below build it
 * unconditionally and let this top-level check decide whether it is ever surfaced.
 */
export function validateAskSpec(input: unknown): AskSpecValidationResult {
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '', message: 'ask spec must be an object' }] }
  }
  const questionsRaw = input.questions
  if (!Array.isArray(questionsRaw)) {
    return { ok: false, errors: [{ path: 'questions', message: 'questions must be an array' }] }
  }

  const errors: AskValidationError[] = []
  if (questionsRaw.length === 0) {
    errors.push({ path: 'questions', message: 'at least one question is required' })
  }
  if (questionsRaw.length > MAX_QUESTIONS) {
    errors.push({ path: 'questions', message: `at most ${MAX_QUESTIONS} questions allowed` })
  }

  const seenIds = new Set<string>()
  const questions = questionsRaw.map((raw, index) =>
    validateQuestion(raw, `questions[${index}]`, errors, seenIds)
  )
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, spec: { questions: questions as AskQuestion[] } }
}

function validateId(raw: unknown, path: string, errors: AskValidationError[], seenIds: Set<string>): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    errors.push({ path: `${path}.id`, message: 'id is required and must be a non-empty string' })
    return ''
  }
  if (seenIds.has(raw)) {
    errors.push({ path: `${path}.id`, message: `duplicate question id '${raw}'` })
  }
  seenIds.add(raw)
  if (CREDENTIAL_PATTERN.test(normalizeCredentialCandidate(raw))) {
    errors.push({ path: `${path}.id`, message: 'credential-shaped id is not permitted' })
  }
  return raw
}

function validateQuestionText(raw: unknown, path: string, errors: AskValidationError[]): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    errors.push({ path: `${path}.question`, message: 'question text is required' })
    return ''
  }
  if (CREDENTIAL_PATTERN.test(normalizeCredentialCandidate(raw))) {
    errors.push({ path: `${path}.question`, message: 'credential-shaped question text is not permitted' })
  }
  return raw
}

function validateQuestion(raw: unknown, path: string, errors: AskValidationError[], seenIds: Set<string>): AskQuestion | Record<string, never> {
  if (!isPlainObject(raw)) {
    errors.push({ path, message: 'question must be an object' })
    return {}
  }
  if ('masked' in raw || 'sensitive' in raw) {
    errors.push({ path, message: 'masked/sensitive input is not permitted; collect credentials out of band' })
  }

  const common: AskQuestionCommon = {
    id: validateId(raw.id, path, errors, seenIds),
    question: validateQuestionText(raw.question, path, errors),
    header: checkOptional(raw.header, isString, `${path}.header`, 'header must be a string', errors),
    required: checkOptional(raw.required, isBoolean, `${path}.required`, 'required must be a boolean', errors)
  }

  const type = raw.type
  if (typeof type !== 'string' || !QUESTION_TYPES.has(type)) {
    errors.push({
      path: `${path}.type`,
      message: 'type must be one of select | multiselect | text | number | date | confirm'
    })
    return {}
  }
  switch (type) {
    case 'select':
    case 'multiselect':
      return validateOptionsQuestion(raw, path, type, common, errors)
    case 'text':
      return validateTextQuestion(raw, path, common, errors)
    case 'number':
      return validateNumberQuestion(raw, path, common, errors)
    default:
      return validateDateOrConfirmQuestion(type as 'date' | 'confirm', raw, path, common, errors)
  }
}

function validatePreview(raw: unknown, path: string, errors: AskValidationError[]): void {
  if (!isPlainObject(raw)) {
    errors.push({ path, message: 'preview must be an object' })
    return
  }
  if (raw.format !== 'markdown' && raw.format !== 'html') {
    errors.push({ path: `${path}.format`, message: "preview format must be 'markdown' or 'html'" })
  }
  if (typeof raw.content !== 'string') {
    errors.push({ path: `${path}.content`, message: 'preview content must be a string' })
  }
}

function validateOption(raw: unknown, path: string, errors: AskValidationError[]): AskOption {
  if (!isPlainObject(raw)) {
    errors.push({ path, message: 'option must be an object' })
    return { value: '', label: '' }
  }
  const value = raw.value
  if (typeof value !== 'string' || value.length === 0) {
    errors.push({ path: `${path}.value`, message: 'option value is required' })
  } else if (CREDENTIAL_PATTERN.test(normalizeCredentialCandidate(value))) {
    errors.push({ path: `${path}.value`, message: 'credential-shaped option value is not permitted' })
  }
  const label = raw.label
  if (typeof label !== 'string' || label.length === 0) {
    errors.push({ path: `${path}.label`, message: 'option label is required' })
  }
  checkOptional(raw.description, isString, `${path}.description`, 'description must be a string', errors)
  if (raw.preview !== undefined) {
    validatePreview(raw.preview, `${path}.preview`, errors)
  }
  return { value: typeof value === 'string' ? value : '', label: typeof label === 'string' ? label : '', description: raw.description as string | undefined, preview: raw.preview as AskPreview | undefined }
}

function validateOptionsQuestion(raw: Record<string, unknown>, path: string, type: 'select' | 'multiselect', common: AskQuestionCommon, errors: AskValidationError[]): AskSelectQuestion | AskMultiselectQuestion {
  const optionsRaw = Array.isArray(raw.options) ? raw.options : []
  if (!Array.isArray(raw.options) || raw.options.length === 0) {
    errors.push({ path: `${path}.options`, message: 'options must be a non-empty array' })
  } else if (raw.options.length > MAX_OPTIONS) {
    errors.push({ path: `${path}.options`, message: `at most ${MAX_OPTIONS} options allowed` })
  }

  const values = new Set<string>()
  const options = optionsRaw.map((rawOption, index) => {
    const option = validateOption(rawOption, `${path}.options[${index}]`, errors)
    values.add(option.value)
    return option
  })

  const defaultValue = raw.default
  const validDefault =
    type === 'select'
      ? typeof defaultValue === 'string' && values.has(defaultValue)
      : Array.isArray(defaultValue) && defaultValue.every((value) => typeof value === 'string' && values.has(value))
  if (defaultValue !== undefined && !validDefault) {
    const message = type === 'select' ? 'default must match one option value' : 'default must be an array of option values'
    errors.push({ path: `${path}.default`, message })
  }
  return { ...common, type, options, default: defaultValue } as AskSelectQuestion | AskMultiselectQuestion
}

function validateTextQuestion(raw: Record<string, unknown>, path: string, common: AskQuestionCommon, errors: AskValidationError[]): AskTextQuestion {
  checkOptional(raw.multiline, isBoolean, `${path}.multiline`, 'multiline must be a boolean', errors)
  let patternRegex: RegExp | undefined
  if (raw.pattern !== undefined) {
    if (typeof raw.pattern !== 'string') {
      errors.push({ path: `${path}.pattern`, message: 'pattern must be a string' })
    } else {
      try {
        patternRegex = new RegExp(raw.pattern)
      } catch {
        errors.push({ path: `${path}.pattern`, message: 'pattern must be a valid regular expression' })
      }
    }
  }
  const format = raw.format
  if (format !== undefined && format !== 'email' && format !== 'url') {
    errors.push({ path: `${path}.format`, message: "format must be 'email' or 'url'" })
  }

  const defaultValue = raw.default
  if (defaultValue !== undefined) {
    if (typeof defaultValue !== 'string') {
      errors.push({ path: `${path}.default`, message: 'default must be a string' })
    } else {
      if (patternRegex && !patternRegex.test(defaultValue)) {
        errors.push({ path: `${path}.default`, message: 'default does not match pattern' })
      }
      if ((format === 'email' || format === 'url') && !FORMAT_PATTERNS[format].test(defaultValue)) {
        errors.push({ path: `${path}.default`, message: `default is not a valid ${format}` })
      }
    }
  }
  return { ...common, type: 'text', multiline: raw.multiline as boolean | undefined, pattern: raw.pattern as string | undefined, format: format as 'email' | 'url' | undefined, default: defaultValue as string | undefined }
}

function validateNumberQuestion(raw: Record<string, unknown>, path: string, common: AskQuestionCommon, errors: AskValidationError[]): AskNumberQuestion {
  checkOptional(raw.integer, isBoolean, `${path}.integer`, 'integer must be a boolean', errors)
  const min = checkOptional(raw.min, isFiniteNumber, `${path}.min`, 'min must be a number', errors)
  const max = checkOptional(raw.max, isFiniteNumber, `${path}.max`, 'max must be a number', errors)
  if (min !== undefined && max !== undefined && min > max) {
    errors.push({ path: `${path}.min`, message: 'min must not exceed max' })
  }

  const defaultValue = raw.default
  if (defaultValue !== undefined && !isFiniteNumber(defaultValue)) {
    errors.push({ path: `${path}.default`, message: 'default must be a number' })
  } else if (isFiniteNumber(defaultValue)) {
    const message =
      (raw.integer === true && !Number.isInteger(defaultValue) && 'default must be an integer') ||
      (min !== undefined && defaultValue < min && 'default is below min') ||
      (max !== undefined && defaultValue > max && 'default is above max')
    if (message) {
      errors.push({ path: `${path}.default`, message })
    }
  }
  return { ...common, type: 'number', integer: raw.integer as boolean | undefined, min, max, default: defaultValue as number | undefined }
}

function validateDateOrConfirmQuestion(type: 'date' | 'confirm', raw: Record<string, unknown>, path: string, common: AskQuestionCommon, errors: AskValidationError[]): AskDateQuestion | AskConfirmQuestion {
  const defaultValue = raw.default
  const isValidDefault =
    type === 'date' ? typeof defaultValue === 'string' && isValidIsoDate(defaultValue) : isBoolean(defaultValue)
  if (defaultValue !== undefined && !isValidDefault) {
    const message = type === 'date' ? 'default must be an ISO 8601 date (YYYY-MM-DD)' : 'default must be a boolean'
    errors.push({ path: `${path}.default`, message })
  }
  return { ...common, type, default: defaultValue } as AskDateQuestion | AskConfirmQuestion
}
