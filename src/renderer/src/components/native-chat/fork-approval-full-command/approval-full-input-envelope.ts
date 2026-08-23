import type { ApprovalFullInputFields } from '../../../../../shared/fork-approval-full-command/approval-full-input'

/** Read the envelope's untruncated-input fields, dropping anything a host on an
 *  older build (or a malformed payload) left absent or non-string. */
export function readApprovalFullInputFields(approval: object): ApprovalFullInputFields {
  const { full, fullField, fullLength } = approval as {
    full?: unknown
    fullField?: unknown
    fullLength?: unknown
  }
  if (typeof full !== 'string' || full.length === 0) {
    return {}
  }
  // Why: the relay compacts `full` to fit a frame without touching `fullLength`,
  // so a length below what arrived is the normal shape, not a corrupt payload —
  // only a nonsensical one (short, negative, non-integer) falls back to the text.
  const declared =
    typeof fullLength === 'number' && Number.isInteger(fullLength) && fullLength >= full.length
      ? fullLength
      : full.length
  return {
    full,
    fullLength: declared,
    ...(typeof fullField === 'string' && fullField.length > 0 ? { fullField } : {})
  }
}
