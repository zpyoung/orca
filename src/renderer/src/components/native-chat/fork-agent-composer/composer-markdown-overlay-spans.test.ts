import { describe, expect, it } from 'vitest'
import {
  buildComposerMarkdownOverlaySpans,
  MAX_HIGHLIGHTED_COMPOSER_LENGTH,
  MAX_HIGHLIGHTED_COMPOSER_SPANS
} from './composer-markdown-overlay-spans'

describe('buildComposerMarkdownOverlaySpans', () => {
  it('keeps Markdown styling for ordinary drafts', () => {
    expect(buildComposerMarkdownOverlaySpans('**bold**')).toContainEqual(
      expect.objectContaining({ kinds: ['bold'] })
    )
  })

  it('degrades oversized pasted drafts to one plain span', () => {
    const text = 'x'.repeat(MAX_HIGHLIGHTED_COMPOSER_LENGTH + 1)

    expect(buildComposerMarkdownOverlaySpans(text)).toEqual([
      { start: 0, end: text.length, kinds: ['plain'] }
    ])
  })

  it('bounds React nodes for highly fragmented drafts', () => {
    const text = Array.from({ length: MAX_HIGHLIGHTED_COMPOSER_SPANS + 1 }, () => '`x`').join(' ')

    expect(buildComposerMarkdownOverlaySpans(text)).toEqual([
      { start: 0, end: text.length, kinds: ['plain'] }
    ])
  })

  it('keeps adversarial incomplete syntax within the typing budget', () => {
    const drafts = [
      `http://x${')'.repeat(16_000)}`,
      `${'['.repeat(8_000)}](${'x'.repeat(8_000)}`,
      '*x '.repeat(5_000),
      '[]('.repeat(5_400)
    ]
    const startedAt = performance.now()

    for (const draft of drafts) {
      expect(buildComposerMarkdownOverlaySpans(draft).at(-1)?.end).toBe(draft.length)
    }
    expect(performance.now() - startedAt).toBeLessThan(750)
    const budgetedDraft = drafts.at(-1) as string
    expect(buildComposerMarkdownOverlaySpans(budgetedDraft)).toEqual([
      { start: 0, end: budgetedDraft.length, kinds: ['plain'] }
    ])
  })
})
