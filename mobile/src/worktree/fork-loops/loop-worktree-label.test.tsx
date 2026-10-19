import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    Text: ({ children, ...props }: { children?: ReactNode }) =>
      React.createElement('Text', props, children),
    StyleSheet: { create: (styles: unknown) => styles }
  }
})

import type { LoopWorktreeSummary, PauseReason } from '../../../../src/shared/fork-loops/loop-types'
import { LoopWorktreeLabel, formatLoopWorktreeLabel } from './loop-worktree-label'

function summary(primary: Partial<LoopWorktreeSummary['primary']>): LoopWorktreeSummary {
  return {
    loopCount: 1,
    primary: { id: 'l1', name: 'l1', state: 'running', iterationsCompleted: 0, ...primary }
  }
}

describe('formatLoopWorktreeLabel', () => {
  it('shows the iteration against the cap when one is set', () => {
    expect(formatLoopWorktreeLabel(summary({ iterationsCompleted: 3, maxIterations: 10 }))).toBe(
      'Loop 3/10 · running'
    )
  })

  it('shows the bare iteration count without a cap', () => {
    expect(formatLoopWorktreeLabel(summary({ iterationsCompleted: 3 }))).toBe('Loop 3 · running')
  })

  it('spells needs-you with a space', () => {
    expect(formatLoopWorktreeLabel(summary({ state: 'needs-you' }))).toBe('Loop 0 · needs you')
  })

  it('names the pause reason', () => {
    expect(
      formatLoopWorktreeLabel(summary({ state: 'paused', pauseReason: 'cap-iterations' }))
    ).toBe('Loop 0 · paused: iteration cap reached')
  })

  it('writes hyphenated pause reasons as plain words', () => {
    expect(formatLoopWorktreeLabel(summary({ state: 'paused', pauseReason: 'no-progress' }))).toBe(
      'Loop 0 · paused: no progress'
    )
  })

  it('maps every pause reason to text without hyphens', () => {
    const reasons: PauseReason[] = [
      'user',
      'cap-iterations',
      'cap-time',
      'cap-cost',
      'no-progress',
      'protected-path',
      'agent-blocked',
      'agent-decide',
      'crashed',
      'usage-limit',
      'interrupted-by-restart',
      'unverifiable',
      'ask-before-next',
      'queue-exhausted'
    ]
    for (const reason of reasons) {
      const label = formatLoopWorktreeLabel(summary({ state: 'paused', pauseReason: reason }))
      expect(label.startsWith('Loop 0 · paused: ')).toBe(true)
      expect(label.slice('Loop 0 · paused: '.length)).not.toMatch(/-/)
    }
  })

  it('unhyphenates a reason this client does not know', () => {
    const unknown = JSON.parse('"cap-future-thing"')
    expect(formatLoopWorktreeLabel(summary({ state: 'paused', pauseReason: unknown }))).toBe(
      'Loop 0 · paused: cap future thing'
    )
  })

  it('falls back to bare paused without a reason', () => {
    expect(formatLoopWorktreeLabel(summary({ state: 'paused' }))).toBe('Loop 0 · paused')
  })

  it('labels ended loops by their state', () => {
    expect(formatLoopWorktreeLabel(summary({ state: 'completed', iterationsCompleted: 5 }))).toBe(
      'Loop 5 · completed'
    )
    expect(formatLoopWorktreeLabel(summary({ state: 'stopped' }))).toBe('Loop 0 · stopped')
  })
})

describe('LoopWorktreeLabel', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function render(loop: LoopWorktreeSummary | undefined): ReactTestRenderer {
    act(() => {
      renderer = create(createElement(LoopWorktreeLabel, { loop }))
    })
    if (!renderer) {
      throw new Error('renderer was not created')
    }
    return renderer
  }

  it('renders nothing when the host sent no loop', () => {
    expect(render(undefined).toJSON()).toBeNull()
  })

  it('renders the label text', () => {
    const tree = render(summary({ iterationsCompleted: 2, maxIterations: 8 })).toJSON()
    expect(JSON.stringify(tree)).toContain('Loop 2/8 · running')
  })
})
