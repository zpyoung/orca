// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import type * as React from 'react'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { NativeChatSessionGate } from './NativeChatSessionGate'
import { useAgentComposerDraft } from './fork-agent-composer/use-agent-composer-draft'
import { clearAgentComposerDraftCacheForTests } from './fork-agent-composer/agent-composer-draft-cache'

function entry(overrides: Partial<AgentStatusEntry> & Pick<AgentStatusEntry, 'paneKey'>) {
  return {
    state: 'working' as const,
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    ...overrides
  }
}

function renderResolution(
  props: Omit<React.ComponentProps<typeof NativeChatSessionGate>, 'children'>
): void {
  render(
    <NativeChatSessionGate {...props}>
      {(resolution) => (
        <div data-testid="native-chat-resolution">
          {resolution.agent}:{resolution.sessionId ?? 'no-session'}:{resolution.paneKey}
        </div>
      )}
    </NativeChatSessionGate>
  )
}

function DraftProbe({ paneKey, sessionId }: { paneKey: string; sessionId: string | null }) {
  const { draft, setDraft } = useAgentComposerDraft(paneKey)
  return (
    <label>
      Session {sessionId ?? 'none'}
      <input
        aria-label="Message draft"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
    </label>
  )
}

describe('NativeChatSessionGate', () => {
  afterEach(() => {
    cleanup()
    clearAgentComposerDraftCacheForTests()
  })

  it('preserves the open composer, session, and draft through disconnect and reconnect', () => {
    const paneKey = 'tab-1:leaf-1'
    const connectedEntry = entry({
      paneKey,
      agentType: 'codex',
      providerSession: { key: 'session_id', id: 'codex-session' }
    })
    const renderGate = (
      agentStatusEntry?: AgentStatusEntry,
      launchAgent: 'codex' | null = null
    ) => (
      <NativeChatSessionGate
        paneKey={paneKey}
        launchAgent={launchAgent}
        resolvedAgent={null}
        agentStatusEntry={agentStatusEntry}
        ptyId={agentStatusEntry ? 'pty-connected' : null}
      >
        {(resolution) => (
          <DraftProbe paneKey={resolution.paneKey} sessionId={resolution.sessionId} />
        )}
      </NativeChatSessionGate>
    )
    const view = render(renderGate(connectedEntry))
    const composer = screen.getByRole('textbox', { name: 'Message draft' })

    fireEvent.change(composer, { target: { value: 'keep this unsent message' } })
    view.rerender(renderGate(undefined, 'codex'))

    expect(screen.getByText('Session codex-session')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message draft' })).toHaveValue(
      'keep this unsent message'
    )

    view.rerender(renderGate())

    expect(screen.getByText('Session codex-session')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message draft' })).toHaveValue(
      'keep this unsent message'
    )

    view.rerender(renderGate(connectedEntry))
    expect(screen.getByText('Session codex-session')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message draft' })).toHaveValue(
      'keep this unsent message'
    )
  })

  it('does not open native chat from an unsupported title fallback', () => {
    renderResolution({
      paneKey: 'tab-1:leaf-1',
      launchAgent: null,
      resolvedAgent: 'gemini',
      ptyId: 'pty-1'
    })

    expect(screen.getByText('No conversation here')).toBeInTheDocument()
    expect(screen.queryByTestId('native-chat-resolution')).not.toBeInTheDocument()
  })
})
