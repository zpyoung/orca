import { describe, expect, it } from 'vitest'
import { estimateHandoffTokens } from './handoff-token-estimate'

describe('estimateHandoffTokens', () => {
  it('returns deterministic estimates for each content class', () => {
    expect(
      estimateHandoffTokens('A concise handoff note with repository context.')
    ).toMatchInlineSnapshot(`8`)
    expect(estimateHandoffTokens('```ts\nconst answer = 42\n```')).toMatchInlineSnapshot(`6`)
    expect(estimateHandoffTokens('```diff\n-old value\n+new value\n```')).toMatchInlineSnapshot(
      `10`
    )
  })

  it('segments a mixed brief across prose, code, and diff fences', () => {
    const text = [
      'Review the implementation.',
      '```ts',
      'export const value = 1',
      '```',
      '```diff',
      '-old',
      '+new',
      '```'
    ].join('\n')

    expect(estimateHandoffTokens(text)).toMatchInlineSnapshot(`18`)
  })

  it('recognizes dynamic backtick and tilde fences', () => {
    const backticks = '`````typescript\nconst marker = `x`\n`````'
    const tildes = '~~~patch\n-a\n+b\n~~~'

    expect(estimateHandoffTokens(backticks)).toBe(9)
    expect(estimateHandoffTokens(tildes)).toBe(6)
  })

  it('classifies unfenced unified-diff lines separately from prose bullets', () => {
    const diff = ['diff --git a/a.ts b/a.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n')
    const bullets = ['- old behavior', '- new behavior', 'Review both items.'].join('\n')

    expect(estimateHandoffTokens(diff)).toBeGreaterThan(estimateHandoffTokens(bullets))
  })

  it('does not reduce estimation to one global character divisor', () => {
    const prose = 'Natural language '.repeat(20).slice(0, 200)
    const code = ['```ts', 'x'.repeat(190), '```'].join('\n')

    expect(prose).toHaveLength(code.length)
    expect(estimateHandoffTokens(code)).toBeGreaterThan(estimateHandoffTokens(prose))
  })

  it('handles empty and very short content', () => {
    expect(estimateHandoffTokens('')).toBe(0)
    expect(estimateHandoffTokens('x')).toBe(1)
  })
})
