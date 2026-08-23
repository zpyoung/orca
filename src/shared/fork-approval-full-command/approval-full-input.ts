// ─── Approval full input ────────────────────────────────────────────────────
// The approval envelope's `summary` is a 200-character preview, which cuts a
// long shell command mid-word — the reader then approves something they cannot
// read. These fields carry the input again at full length, with `fullLength`
// stating how long it really was.

/** Envelope key holding the untruncated input. The relay compacts by key name. */
export const APPROVAL_FULL_INPUT_FIELD = 'full'

/** Longest raw input text carried in the envelope. */
export const APPROVAL_FULL_INPUT_MAX_LENGTH = 6000

// Why: the status normalizer hard-slices `interactivePrompt` at 16000 chars,
// which would cut the JSON mid-token and destroy the whole envelope — not just
// this field. Budget the *encoded* length so escape-heavy input (a command that
// is mostly quotes and newlines encodes to twice its size) can't reach that cap.
const APPROVAL_FULL_INPUT_MAX_ENCODED_LENGTH = 12000

// Mirrors the preview's field order in summarizeApprovalInput.
const APPROVAL_INPUT_FIELDS = ['command', 'file_path', 'path', 'url', 'pattern'] as const

/**
 * Untruncated approval input, the field it came from, and the input's true
 * length. `full` is shortened by this module's cap and again by the relay when
 * a frame will not fit, and neither clip can announce itself in the text — so
 * `fullLength` is what lets a reader tell a whole command from a cut one.
 */
export type ApprovalFullInputFields = {
  full?: string
  fullField?: string
  fullLength?: number
}

function jsonFallback(toolInput: unknown): { text: string; field: string } | null {
  try {
    const json = JSON.stringify(toolInput) ?? ''
    return json.length > 0 ? { text: json, field: 'json' } : null
  } catch {
    return null
  }
}

function readApprovalInput(toolInput: unknown): { text: string; field: string } | null {
  if (!toolInput || typeof toolInput !== 'object') {
    return jsonFallback(toolInput)
  }
  const obj = toolInput as Record<string, unknown>
  for (const field of APPROVAL_INPUT_FIELDS) {
    const value = obj[field]
    // Why: `??` semantics — the first present field wins even when it holds a
    // non-string or an empty string, so this stays in step with the preview.
    if (value === undefined || value === null) {
      continue
    }
    return typeof value === 'string' && value.length > 0
      ? { text: value, field }
      : jsonFallback(toolInput)
  }
  return jsonFallback(toolInput)
}

// Why: a cut between a surrogate pair leaves a lone high surrogate that renders
// as the replacement glyph; drop it so the result is always valid UTF-16.
function sliceWholeCodePoints(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value
  }
  const sliced = value.slice(0, maxLength)
  const lastCode = sliced.charCodeAt(sliced.length - 1)
  return lastCode >= 0xd800 && lastCode <= 0xdbff ? sliced.slice(0, -1) : sliced
}

function fitEnvelopeBudget(value: string): string {
  let text = sliceWholeCodePoints(value, APPROVAL_FULL_INPUT_MAX_LENGTH)
  let encoded = JSON.stringify(text).length
  while (text.length > 1 && encoded > APPROVAL_FULL_INPUT_MAX_ENCODED_LENGTH) {
    const target = Math.floor((text.length * APPROVAL_FULL_INPUT_MAX_ENCODED_LENGTH) / encoded)
    text = sliceWholeCodePoints(text, Math.max(1, Math.min(target, text.length - 1)))
    encoded = JSON.stringify(text).length
  }
  return text
}

/**
 * Build the envelope's untruncated-input fields for a PermissionRequest.
 * Returns nothing when the preview already shows the whole input, so a short
 * command never grows the payload or offers an expander with nothing behind it.
 */
export function approvalFullInputFields(
  toolInput: unknown,
  summary: string
): ApprovalFullInputFields {
  const read = readApprovalInput(toolInput)
  if (!read) {
    return {}
  }
  const full = fitEnvelopeBudget(read.text)
  return full === summary ? {} : { full, fullField: read.field, fullLength: read.text.length }
}
