// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useTerminalDockPtyBindingRevision } from './use-terminal-dock-pty-binding-revision'

function renderRevisionHook(initialEnabled: boolean) {
  let renderCount = 0
  const view = renderHook(
    ({ enabled }: { enabled: boolean }) => {
      renderCount += 1
      return useTerminalDockPtyBindingRevision(enabled)
    },
    { initialProps: { enabled: initialEnabled } }
  )
  return { view, renders: () => renderCount }
}

describe('useTerminalDockPtyBindingRevision', () => {
  it('re-renders on every call, including a repeat for an unchanged pty id', () => {
    const { view, renders } = renderRevisionHook(true)
    const before = renders()

    act(() => view.result.current())
    act(() => view.result.current())

    // The layout store dedupes a same-id rebind; this hook must not, or a reattach to the
    // id the layout already holds leaves the dock rendering its pre-attach null.
    expect(renders()).toBe(before + 2)
  })

  it('does not re-render while the dock flag is off', () => {
    const { view, renders } = renderRevisionHook(false)
    const before = renders()

    act(() => view.result.current())

    expect(renders()).toBe(before)
  })

  it('keeps a stable callback identity across an enabled flip', () => {
    const { view, renders } = renderRevisionHook(false)
    const disabledCallback = view.result.current

    view.rerender({ enabled: true })
    expect(view.result.current).toBe(disabledCallback)

    const before = renders()
    act(() => view.result.current())
    expect(renders()).toBe(before + 1)
  })
})
