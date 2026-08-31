// @vitest-environment happy-dom

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SourceControlDirtyIcon } from './source-control-dirty-icon'

// Each case renders more than once, so query the render's own container rather
// than the shared document body.
function renderIcon(size?: number): HTMLElement {
  const { container } = render(<SourceControlDirtyIcon size={size} />)
  return container.querySelector('[data-testid="source-control-dirty-icon"]') as HTMLElement
}

function dotOf(wrapper: HTMLElement): HTMLElement {
  return wrapper.querySelector('span') as HTMLElement
}

describe('SourceControlDirtyIcon', () => {
  it('keeps the glyph at the requested activity-bar size', () => {
    const wrapper = renderIcon(18)
    expect(wrapper.style.width).toBe('18px')
    expect(wrapper.querySelector('svg')?.getAttribute('width')).toBe('18')
  })

  it('paints the dot with the git modified decoration token', () => {
    expect(dotOf(renderIcon(16)).style.background).toContain('--git-decoration-modified')
  })

  it('scales the dot down with the icon so the overflow menu stays legible', () => {
    expect(dotOf(renderIcon(14)).style.width).toBe('5px')
    expect(dotOf(renderIcon(16)).style.width).toBe('6px')
    expect(dotOf(renderIcon(18)).style.width).toBe('7px')
  })
})
