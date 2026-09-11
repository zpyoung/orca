// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { trackPaneFocusOwnership } from './terminal-pane-dock-focus'

function makeContainerWithChild(): { container: HTMLElement; child: HTMLTextAreaElement } {
  const container = document.createElement('div')
  const child = document.createElement('textarea')
  container.appendChild(child)
  document.body.appendChild(container)
  return { container, child }
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('trackPaneFocusOwnership', () => {
  it('seeds true when focus already lives inside the container', () => {
    const { container, child } = makeContainerWithChild()
    child.focus()

    const tracker = trackPaneFocusOwnership(container)
    expect(tracker.hasFocus()).toBe(true)
    tracker.dispose()
  })

  it('seeds false when nothing inside the container is focused', () => {
    const { container } = makeContainerWithChild()

    const tracker = trackPaneFocusOwnership(container)
    expect(tracker.hasFocus()).toBe(false)
    tracker.dispose()
  })

  it('flips true when focus enters the container', () => {
    const { container, child } = makeContainerWithChild()
    const tracker = trackPaneFocusOwnership(container)
    expect(tracker.hasFocus()).toBe(false)

    child.focus()
    expect(tracker.hasFocus()).toBe(true)
    tracker.dispose()
  })

  it('flips false when focus moves to an element outside the container', () => {
    const { container, child } = makeContainerWithChild()
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    child.focus()

    const tracker = trackPaneFocusOwnership(container)
    expect(tracker.hasFocus()).toBe(true)

    outside.focus()
    expect(tracker.hasFocus()).toBe(false)
    tracker.dispose()
  })

  it('ignores focus landing on document.body (removal fixup noise)', () => {
    const { container, child } = makeContainerWithChild()
    child.focus()
    const tracker = trackPaneFocusOwnership(container)
    expect(tracker.hasFocus()).toBe(true)

    document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    expect(tracker.hasFocus()).toBe(true)
    tracker.dispose()
  })

  it('stops tracking after dispose', () => {
    const { container, child } = makeContainerWithChild()
    const tracker = trackPaneFocusOwnership(container)
    tracker.dispose()

    child.focus()
    expect(tracker.hasFocus()).toBe(false)
  })
})
