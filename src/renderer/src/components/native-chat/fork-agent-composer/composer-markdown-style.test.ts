import { describe, expect, it } from 'vitest'
import {
  COMPOSER_MARKDOWN_KIND_CLASS,
  composerMarkdownSpanClassName
} from './composer-markdown-style'

describe('composer Markdown styles', () => {
  it('uses only paint-level emphasis in the span style map', () => {
    const classes = Object.values(COMPOSER_MARKDOWN_KIND_CLASS).join(' ')

    expect(classes).not.toMatch(/(?:^|\s)font-(?:\S+)/)
    expect(classes).not.toMatch(/(?:^|\s)text-(?:xs|sm|base|lg|xl|\d)/)
    expect(classes).not.toMatch(/(?:^|\s)(?:tracking|scale|translate|skew)-/)
    expect(classes).not.toMatch(/(?:^|\s)(?:italic|not-italic)(?:$|\s)/)
  })

  it('keeps syntax markers muted when they overlap another role', () => {
    expect(composerMarkdownSpanClassName(['bold', 'marker'])).toContain('text-muted-foreground/50')
  })
})
