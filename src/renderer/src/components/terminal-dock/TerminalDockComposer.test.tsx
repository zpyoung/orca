// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ASK_PROMPT = JSON.stringify({
  questions: [
    {
      question: 'Choose an editor?',
      multiSelect: false,
      options: [{ label: 'Vim' }, { label: 'Emacs' }]
    }
  ]
})

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  status: {
    state: 'waiting',
    prompt: 'status prompt',
    stateHistory: [] as { state: string; prompt: string; startedAt: number }[],
    interactivePrompt: JSON.stringify({
      questions: [
        {
          question: 'Choose an editor?',
          multiSelect: false,
          options: [{ label: 'Vim' }, { label: 'Emacs' }]
        }
      ]
    }) as string | undefined,
    toolName: 'AskUserQuestion' as string | undefined,
    paneKey: 'pane-1',
    updatedAt: 2,
    stateStartedAt: 2
  },
  messages: [
    {
      id: 'user-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'status prompt' }],
      timestamp: 1,
      source: 'transcript'
    }
  ]
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ agentStatusByPaneKey: { 'pane-1': mocks.status } })
}))
vi.mock('../native-chat/native-chat-runtime-owner', () => ({
  selectNativeChatRuntimeEnvironmentId: () => null
}))
vi.mock('../native-chat/use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: () => ({ messages: mocks.messages, readPhase: 'ready' })
}))
vi.mock('../native-chat/use-native-chat-interactive-send', () => ({
  useNativeChatInteractiveSend: () => ({
    sendAnswer: vi.fn(() => ({ settleAfterMs: 0, waitsForVerifiedDelivery: false })),
    sendRaw: vi.fn(),
    cancelPending: vi.fn(),
    cancel: mocks.cancel
  })
}))
vi.mock('../native-chat/NativeChatComposer', () => ({
  NativeChatComposer: function Composer(props: {
    canSend: boolean
    sendDisabled?: boolean
    isWorking: boolean
    onStop?: () => void
    historyPrompts?: readonly string[]
  }) {
    return (
      <div>
        <textarea aria-label="Dock composer" disabled={!props.canSend} />
        <button aria-label="Send dock message" disabled={props.sendDisabled} />
        <output data-testid="history">{props.historyPrompts?.join('|')}</output>
        {props.isWorking ? <button onClick={props.onStop}>Stop the agent</button> : null}
      </div>
    )
  }
}))

import { TerminalDockComposer } from './TerminalDockComposer'

const baseProps = {
  ref: null,
  terminalTabId: 'tab-1',
  paneKey: 'pane-1',
  targetPtyId: 'pty-1',
  agent: 'claude' as const,
  canSend: true,
  sendTier: 'verified' as const
}

describe('TerminalDockComposer', () => {
  beforeEach(() => {
    mocks.status.state = 'waiting'
    mocks.status.interactivePrompt = ASK_PROMPT
    mocks.status.toolName = 'AskUserQuestion'
    mocks.status.prompt = 'status prompt'
    mocks.status.stateHistory = []
    vi.clearAllMocks()
  })

  afterEach(cleanup)

  it('renders card-tier prompts upward and disables only Send in the mounted composer', async () => {
    const { container } = render(<TerminalDockComposer {...baseProps} />)

    expect(screen.getByText('Choose an editor?')).toBeInTheDocument()
    const overlay = container.querySelector('[data-terminal-dock-card-overlay]')
    expect(overlay).toHaveClass('absolute', 'bottom-full')
    expect(overlay?.parentElement).not.toHaveClass('overflow-hidden')
    await waitFor(() => expect(screen.getByLabelText('Send dock message')).toBeDisabled())
    expect(screen.getByLabelText('Dock composer')).toBeEnabled()
  })

  it('shows Stop only from working status and routes it through card send cancellation', () => {
    mocks.status.interactivePrompt = undefined
    mocks.status.state = 'working'
    const { rerender } = render(<TerminalDockComposer {...baseProps} />)

    fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }))
    expect(mocks.cancel).toHaveBeenCalledTimes(1)

    mocks.status.state = 'waiting'
    rerender(<TerminalDockComposer {...baseProps} />)
    expect(screen.queryByRole('button', { name: 'Stop the agent' })).not.toBeInTheDocument()
  })

  it('seeds shared history from transcript plus status without duplicate prompts', () => {
    mocks.status.interactivePrompt = undefined
    mocks.status.stateHistory = [
      { state: 'done', prompt: 'older prompt', startedAt: 1 },
      { state: 'waiting', prompt: 'status prompt', startedAt: 2 }
    ]
    render(<TerminalDockComposer {...baseProps} />)

    expect(screen.getByTestId('history')).toHaveTextContent('older prompt|status prompt')
    expect(screen.getByTestId('history').textContent?.match(/status prompt/g)).toHaveLength(1)
  })

  it('omits cards for input-tier agents and still routes working Stop through ESC cancellation', () => {
    mocks.status.state = 'working'
    render(<TerminalDockComposer {...baseProps} agent="gemini" sendTier="input" />)

    expect(document.querySelector('[data-terminal-dock-card-overlay]')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Dock composer')).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Stop the agent' }))
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
  })
})
