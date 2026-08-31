// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { createRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ComposerMarkdownOverlay } from './ComposerMarkdownOverlay'

function renderOverlay(text: string, disabled = false, layout?: 'dock'): HTMLElement {
  const textareaRef = createRef<HTMLTextAreaElement>()
  const { container } = render(
    <div>
      <textarea ref={textareaRef} value={text} readOnly />
      <ComposerMarkdownOverlay
        text={text}
        disabled={disabled}
        layout={layout}
        textareaRef={textareaRef}
      />
    </div>
  )
  return container.querySelector('[data-composer-markdown-overlay]') as HTMLElement
}

afterEach(() => cleanup())

describe('ComposerMarkdownOverlay', () => {
  it('is read-only to pointer and accessibility input', () => {
    const overlay = renderOverlay('**bold**')

    expect(overlay).toHaveAttribute('aria-hidden', 'true')
    expect(overlay).toHaveClass('pointer-events-none')
    expect(overlay.querySelector('[data-markdown-kinds="bold"]')).toHaveTextContent('bold')
  })

  it('preserves wrapping whitespace and the textarea trailing line', () => {
    const text = 'first  line\nsecond\n'
    const overlay = renderOverlay(text)

    expect(overlay).toHaveClass('whitespace-pre-wrap', 'break-words')
    expect(overlay.textContent).toBe(`${text}\n`)
  })

  it('shares the textarea metric classes without exposing a second scrollbar thumb', () => {
    const overlay = renderOverlay('text')

    for (const className of ['block', 'w-full', 'px-2', 'py-1', 'text-sm', 'scrollbar-sleek']) {
      expect(overlay).toHaveClass(className)
    }
    expect(overlay.style.scrollbarColor).toBe('transparent transparent')
    expect(overlay.className).toContain('[&::-webkit-scrollbar-thumb]:!bg-transparent')
  })

  it('matches disabled and dock sizing states', () => {
    expect(renderOverlay('text', true)).toHaveClass('opacity-50', 'min-h-12')
    const dockOverlay = renderOverlay('text', false, 'dock')
    expect(dockOverlay).toHaveClass('min-h-0')
    expect(dockOverlay).not.toHaveClass('min-h-12')
  })
})
