import { tokenizeComposerMarkdown, type ComposerMarkdownSpan } from './composer-markdown-spans'

export const MAX_HIGHLIGHTED_COMPOSER_LENGTH = 16_384
export const MAX_HIGHLIGHTED_COMPOSER_SPANS = 1_500

/** Builds bounded overlay spans and degrades large or highly fragmented drafts to plain text. */
export function buildComposerMarkdownOverlaySpans(text: string): ComposerMarkdownSpan[] {
  if (text.length === 0) {
    return []
  }
  if (text.length > MAX_HIGHLIGHTED_COMPOSER_LENGTH) {
    return plainSpan(text)
  }

  const spans = tokenizeComposerMarkdown(text)
  return spans.length > MAX_HIGHLIGHTED_COMPOSER_SPANS ? plainSpan(text) : spans
}

function plainSpan(text: string): ComposerMarkdownSpan[] {
  return [{ start: 0, end: text.length, kinds: ['plain'] }]
}
