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

  it('colors the glyph of a recognized tool on a ToolLine', () => {
    const blocks: NativeChatBlock[] = [{ type: 'tool-call', name: 'Bash', input: '{}' }]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)

    const row = container.querySelector('[class*="group/tool-line"]')
    expect(row?.querySelector('[class*="text-tool-exec"]')).toBeInTheDocument()
  })

  it('leaves an unrecognized tool name uncolored', () => {
    const blocks: NativeChatBlock[] = [{ type: 'tool-call', name: 'SomeMcpTool', input: '{}' }]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)

    const row = container.querySelector('[class*="group/tool-line"]')
    expect(row).toBeInTheDocument()
    expect(row?.querySelector('[class*="text-tool-"]')).toBeNull()
  })

  it('folds a tool result into its call row', () => {
    const blocks: NativeChatBlock[] = [
      { type: 'tool-call', name: 'Bash', input: '{}' },
      { type: 'tool-result', output: 'done', isError: false }
    ]

    const { container } = render(<NativeChatToolRun blocks={blocks} expandSignal />)

    expect(container.querySelectorAll('[class*="group/tool-line"]')).toHaveLength(1)
    expect(screen.queryByText('Result')).toBeNull()
  })
})
