import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = fs.readFileSync(new URL('../fork-native-chat-coloring.css', import.meta.url), 'utf8')

// Region boundaries anchored on stable text, not line numbers.
const regionStart = css.indexOf('CodeBlockLowlight')
const regionEnd = css.length
expect(regionStart).toBeGreaterThanOrEqual(0)
expect(regionEnd).toBeGreaterThan(regionStart)
const hljsRegion = css.slice(regionStart, regionEnd)

const darkStart = hljsRegion.indexOf('.dark .rich-markdown-code-block-wrapper .hljs-keyword {')
expect(darkStart).toBeGreaterThan(0)
const lightBlock = hljsRegion.slice(0, darkStart)
const darkBlock = hljsRegion.slice(darkStart)

function getRuleBody(block: string, selectorSuffix: string): string {
  const marker = `${selectorSuffix} {`
  const idx = block.indexOf(marker)
  expect(idx).toBeGreaterThanOrEqual(0)
  const bodyStart = idx + marker.length
  const bodyEnd = block.indexOf('}', bodyStart)
  return block.slice(bodyStart, bodyEnd)
}

// [class name as used in the selector, token name after the --hljs- prefix]
const HLJS_TOKENS: [string, string][] = [
  ['hljs-keyword', 'keyword'],
  ['hljs-string', 'string'],
  ['hljs-number', 'number'],
  ['hljs-comment', 'comment'],
  ['hljs-function', 'function'],
  ['hljs-title', 'title'],
  ['hljs-built_in', 'built-in'],
  ['hljs-type', 'type'],
  ['hljs-attr', 'attr'],
  ['hljs-selector-class', 'selector-class'],
  ['hljs-variable', 'variable'],
  ['hljs-meta', 'meta'],
  ['hljs-tag', 'tag'],
  ['hljs-name', 'name'],
  ['hljs-params', 'params'],
  ['hljs-literal', 'literal'],
  ['hljs-regexp', 'regexp'],
  ['hljs-operator', 'operator'],
  ['hljs-property', 'property']
]

describe('hljs token color promotion cascade overrides', () => {
  it.each(HLJS_TOKENS)(
    '%s uses var(--hljs-%s) in both light and dark blocks',
    (className, token) => {
      const lightBody = getRuleBody(lightBlock, `.rich-markdown-code-block-wrapper .${className}`)
      const darkBody = getRuleBody(
        darkBlock,
        `.dark .rich-markdown-code-block-wrapper .${className}`
      )

      expect(lightBody).toContain(`color: var(--hljs-${token});`)
      expect(darkBody).toContain(`color: var(--hljs-${token});`)
    }
  )

  it('keeps the hljs-built_in selector underscore while consuming the hyphenated token', () => {
    const lightBody = getRuleBody(lightBlock, '.rich-markdown-code-block-wrapper .hljs-built_in')
    const darkBody = getRuleBody(
      darkBlock,
      '.dark .rich-markdown-code-block-wrapper .hljs-built_in'
    )

    expect(lightBlock).toContain('.hljs-built_in {')
    expect(darkBlock).toContain('.hljs-built_in {')
    expect(lightBody).toContain('color: var(--hljs-built-in);')
    expect(darkBody).toContain('color: var(--hljs-built-in);')
  })

  it('has no hardcoded hex colors left in the hljs region', () => {
    expect(hljsRegion).not.toMatch(/#[0-9a-fA-F]{3,6}\b/)
  })

  it('preserves font-style: italic on hljs-comment in both blocks', () => {
    const lightBody = getRuleBody(lightBlock, '.rich-markdown-code-block-wrapper .hljs-comment')
    const darkBody = getRuleBody(darkBlock, '.dark .rich-markdown-code-block-wrapper .hljs-comment')

    expect(lightBody).toContain('font-style: italic;')
    expect(darkBody).toContain('font-style: italic;')
  })
})
