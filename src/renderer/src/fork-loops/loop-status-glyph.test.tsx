// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { WorktreeStatus } from '@/lib/worktree-status'
import { useAppStore } from '@/store'
import type { LoopSnapshot } from '../../../shared/fork-loops/loop-types'
import { useLoopGlyph, withLoopGlyph } from './loop-status-glyph'

const initialState = useAppStore.getInitialState()
let root: Root | null = null
let container: HTMLDivElement
const openTab = vi.fn()

function makeLoop(
  overrides: Partial<LoopSnapshot> & { id: string; maxIterations?: number | null }
): LoopSnapshot {
  const { maxIterations = 10, ...snapshot } = overrides
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test fixture supplies only the fields the glyph reads.
  return {
    worktreeId: 'wt-1',
    name: 'loop',
    state: 'running',
    detached: false,
    iterationsCompleted: 3,
    config: { caps: maxIterations === null ? {} : { maxIterations } },
    ...snapshot
  } as LoopSnapshot
}

function seed(...loops: LoopSnapshot[]): void {
  for (const loop of loops) {
    useAppStore.getState().applyLoopSnapshot(loop)
  }
}

function Probe({
  status,
  worktreeId = 'wt-1',
  nested = false
}: {
  status: WorktreeStatus
  worktreeId?: string
  nested?: boolean
}): React.JSX.Element {
  const glyph = useLoopGlyph(worktreeId, status, 'Idle')
  return nested
    ? withLoopGlyph(glyph, <span data-testid="fallback" />)
    : (glyph ?? <span data-testid="none" />)
}

async function renderProbe(props: React.ComponentProps<typeof Probe>): Promise<void> {
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <Probe {...props} />
      </TooltipProvider>
    )
  })
}

function lane(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-loop-lane]')
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  useAppStore.setState({ ...initialState }, true)
  openTab.mockReset().mockResolvedValue(undefined)
  Object.assign(window, { api: { loops: { openTab } } })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.replaceChildren()
  useAppStore.setState(initialState, true)
})

describe('loop status glyph', () => {
  it('renders nothing for a worktree without a live loop', async () => {
    seed(makeLoop({ id: 'done', state: 'completed' }), makeLoop({ id: 'off', state: 'stopped' }))
    await renderProbe({ status: 'inactive' })
    expect(lane()).toBeNull()

    await renderProbe({ status: 'inactive', worktreeId: 'wt-other' })
    expect(lane()).toBeNull()
  })

  it.each([
    ['running', {}, 'Loop 3/10 · Running'],
    ['needs-you', { state: 'needs-you' as const }, 'Loop 3/10 · Needs you'],
    ['paused', { state: 'paused' as const }, 'Loop 3/10 · Paused'],
    ['detached', { detached: true }, 'Loop 3/10 · Detached']
  ])('labels a %s loop', async (stateName, overrides, label) => {
    seed(makeLoop({ id: 'l1', ...overrides }))
    await renderProbe({ status: 'inactive' })

    expect(lane()?.getAttribute('data-loop-state')).toBe(stateName)
    expect(lane()?.textContent).toContain(label)
  })

  it('drops the cap from the label when the loop has none', async () => {
    seed(makeLoop({ id: 'l1', maxIterations: null }))
    await renderProbe({ status: 'inactive' })
    expect(lane()?.textContent).toContain('Loop 3 · Running')
  })

  it('prefers the loop that needs the user', async () => {
    seed(makeLoop({ id: 'a' }), makeLoop({ id: 'b', state: 'needs-you' }))
    await renderProbe({ status: 'inactive' })
    expect(lane()?.getAttribute('data-loop-state')).toBe('needs-you')
  })

  it('yields to a busy agent status unless the loop needs the user or is detached', async () => {
    seed(makeLoop({ id: 'l1' }))
    await renderProbe({ status: 'working' })
    expect(lane()).toBeNull()

    useAppStore.getState().applyLoopSnapshot(makeLoop({ id: 'l1', state: 'needs-you' }))
    await renderProbe({ status: 'working' })
    expect(lane()).not.toBeNull()

    useAppStore.getState().applyLoopSnapshot(makeLoop({ id: 'l1', detached: true }))
    await renderProbe({ status: 'working' })
    expect(lane()).not.toBeNull()
  })

  it('opens the tab of a detached loop from the glyph', async () => {
    seed(makeLoop({ id: 'l1', detached: true }))
    await renderProbe({ status: 'inactive' })

    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Open loop"]')
    expect(button).not.toBeNull()
    await act(async () => button?.click())

    expect(openTab).toHaveBeenCalledWith('l1')
  })

  it('has no open action for an attached loop', async () => {
    seed(makeLoop({ id: 'l1' }))
    await renderProbe({ status: 'inactive' })
    expect(container.querySelector('button')).toBeNull()
  })

  it('stays free of nested buttons when placed inside the unread action', async () => {
    seed(makeLoop({ id: 'l1', detached: true }))
    await renderProbe({ status: 'inactive', nested: true })

    expect(lane()).not.toBeNull()
    expect(container.querySelector('button')).toBeNull()
  })

  it('keeps the fallback when there is no loop', async () => {
    await renderProbe({ status: 'inactive', nested: true })
    expect(lane()).toBeNull()
    expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull()
  })
})
