// @vitest-environment happy-dom

import { useRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useComposerScrollSync } from './use-composer-scroll-sync'

function ScrollSyncHarness({ text }: { text: string }): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useComposerScrollSync(textareaRef, text)

  return (
    <>
      <textarea ref={textareaRef} data-testid="textarea" value={text} readOnly />
      <div ref={overlayRef} data-testid="overlay">
        {text}
      </div>
    </>
  )
}

afterEach(() => cleanup())

describe('useComposerScrollSync', () => {
  it('copies both scroll axes from native textarea scroll events', () => {
    render(<ScrollSyncHarness text="draft" />)
    const textarea = screen.getByTestId('textarea')
    const overlay = screen.getByTestId('overlay')

    textarea.scrollTop = 48
    textarea.scrollLeft = 17
    fireEvent.scroll(textarea)

    expect(overlay.scrollTop).toBe(48)
    expect(overlay.scrollLeft).toBe(17)
  })

  it('re-syncs after the draft changes', () => {
    const { rerender } = render(<ScrollSyncHarness text="first" />)
    const textarea = screen.getByTestId('textarea')
    const overlay = screen.getByTestId('overlay')
    textarea.scrollTop = 72
    textarea.scrollLeft = 9

    rerender(<ScrollSyncHarness text="second" />)

    expect(overlay.scrollTop).toBe(72)
    expect(overlay.scrollLeft).toBe(9)
  })
})
