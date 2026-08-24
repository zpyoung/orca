// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AskCardModel as StoreAskCardModel } from '@/store/slices/fork-ask-question-tool/asks'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'

const storeState: { pendingAsksByPaneKey: Record<string, StoreAskCardModel[]> } = {
  pendingAsksByPaneKey: {}
}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

import { AskTerminalPaneDock } from './AskTerminalPaneDock'

function successResponse<T>(result: T): RuntimeRpcResponse<T> {
  return { id: 'req-1', ok: true, result, _meta: { runtimeId: 'rt' } }
}

function card(overrides: Partial<StoreAskCardModel> = {}): StoreAskCardModel {
  return {
    askId: 'ask-1',
    paneKey: 'pane-a',
    status: 'registered',
    spec: { questions: [{ id: 'name', type: 'text', question: 'Project name?' }] },
    partial: {},
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  storeState.pendingAsksByPaneKey = {}
  vi.unstubAllGlobals()
})

describe('AskTerminalPaneDock', () => {
  it('renders nothing when the pane has no pending ask', () => {
    const { container } = render(<AskTerminalPaneDock paneKey="pane-a" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when the head entry has no spec yet', () => {
    storeState.pendingAsksByPaneKey['pane-a'] = [card({ spec: null })]
    const { container } = render(<AskTerminalPaneDock paneKey="pane-a" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the head ask and leaves a queued second ask unrendered', () => {
    storeState.pendingAsksByPaneKey['pane-a'] = [
      card({ askId: 'ask-1', spec: { questions: [{ id: 'name', type: 'text', question: 'First?' }] } }),
      card({ askId: 'ask-2', spec: { questions: [{ id: 'name', type: 'text', question: 'Second?' }] } })
    ]
    render(<AskTerminalPaneDock paneKey="pane-a" />)
    expect(screen.getByRole('textbox', { name: 'First?' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Second?' })).not.toBeInTheDocument()
  })

  it('submits the answer through ask.answer for the head askId', () => {
    const call = vi.fn().mockResolvedValue(successResponse({ committed: true }))
    vi.stubGlobal('window', { api: { runtime: { call } } })
    storeState.pendingAsksByPaneKey['pane-a'] = [card()]

    render(<AskTerminalPaneDock paneKey="pane-a" />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Project name?' }), { target: { value: 'orca' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(call).toHaveBeenCalledWith({
      method: 'ask.answer',
      params: { askId: 'ask-1', answers: { name: { value: 'orca', source: 'input' } }, skipped: [] }
    })
  })

  it('cancels through ask.cancel for the head askId', () => {
    const call = vi.fn().mockResolvedValue(successResponse({ status: 'declined', askId: 'ask-1' }))
    vi.stubGlobal('window', { api: { runtime: { call } } })
    storeState.pendingAsksByPaneKey['pane-a'] = [card()]

    render(<AskTerminalPaneDock paneKey="pane-a" />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(call).toHaveBeenCalledWith({ method: 'ask.cancel', params: { askId: 'ask-1' } })
  })
})
