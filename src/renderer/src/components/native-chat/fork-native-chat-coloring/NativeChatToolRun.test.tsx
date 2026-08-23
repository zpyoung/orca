// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatBlock } from '../../../../../shared/native-chat-types'
import { NativeChatToolRun } from '../NativeChatToolRun'

afterEach(cleanup)

describe('NativeChatToolRun coloring', () => {
  it('renders one dot per distinct category in first-seen order', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'Bash', input: '{}' },
      { type: 'tool-call', name: 'Read', input: '{}' },
      { type: 'tool-call', name: 'WebFetch', input: '{}' }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal={false} />)

    const dots = container.querySelectorAll('[data-tool-category-dot]')
    expect(Array.from(dots).map((dot) => dot.getAttribute('data-tool-category-dot'))).toEqual([
      'exec',
      'read',
      'net'
    ])
  })

  it('collapses a repeated category into a single dot without disturbing order', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'Read', input: '{}' },
      { type: 'tool-call', name: 'Bash', input: '{}' },
      { type: 'tool-call', name: 'Read', input: '{}' }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal={false} />)

    const dots = container.querySelectorAll('[data-tool-category-dot]')
    expect(Array.from(dots).map((dot) => dot.getAttribute('data-tool-category-dot'))).toEqual([
      'read',
      'exec'
    ])
  })

  it('renders no dots for a run of only unrecognized tool names', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'SomeMcpTool', input: '{}' },
      { type: 'tool-call', name: 'AnotherThing', input: '{}' }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal={false} />)

    expect(container.querySelectorAll('[data-tool-category-dot]')).toHaveLength(0)
  })

  it('renders the recognized-tool glyph and color class on a ToolLine', () => {
    const blocks: NativeChatBlock[] = [{ type: 'tool-call', name: 'Bash', input: '{}' }]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)

    expect(container.querySelector('[data-tool-category-glyph="exec"]')).toBeInTheDocument()
    const code = screen.getByText('Bash')
    expect(code.className).toContain('text-tool-exec')
  })

  it('renders neither glyph nor color class for an unrecognized tool name', () => {
    const blocks: NativeChatBlock[] = [{ type: 'tool-call', name: 'SomeMcpTool', input: '{}' }]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)

    expect(container.querySelector('[data-tool-category-glyph]')).toBeNull()
    const code = screen.getByText('SomeMcpTool')
    expect(code.className).not.toMatch(/text-tool-/)
    expect(code.className).toContain('text-foreground/90')
  })

  it('gives a tool result block no glyph and no category color', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'Bash', input: '{}' },
      { type: 'tool-result', output: 'done', isError: false }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)

    const glyphs = container.querySelectorAll('[data-tool-category-glyph]')
    expect(glyphs).toHaveLength(1)
    const resultCode = screen.getByText('Result')
    expect(resultCode.className).not.toMatch(/text-tool-/)
  })
})
