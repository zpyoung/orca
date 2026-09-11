// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../shared/native-chat-types'
import { NativeChatMessageList } from '../NativeChatMessageList'
import type { NativeChatLiveSession } from '../use-native-chat-live-session'

afterEach(cleanup)

const FENCED_CODE = ['```js', 'const answer = 42;', '```'].join('\n')

function messageWith(role: NativeChatMessage['role'], id: string, text: string): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text }],
    timestamp: 1,
    source: 'transcript'
  }
}

function sessionWith(messages: NativeChatMessage[]): NativeChatLiveSession {
  return {
    messages,
    status: 'ready',
    sessionId: null,
    agent: 'claude',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: () => {},
    readPhase: 'ready'
  }
}

describe('NativeChatMessageList code coloring', () => {
  it('colors a fenced code block in an assistant message with hljs token classes', () => {
    const { container } = render(
      <NativeChatMessageList
        session={sessionWith([messageWith('assistant', 'a1', FENCED_CODE)])}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
        onLinkClick={() => {}}
      />
    )

    const tokens = container.querySelectorAll('[class*="hljs"]')
    expect(tokens.length).toBeGreaterThan(0)
  })

  it('marks the markdown wrapper with the native-chat-code class the stylesheet targets', () => {
    const { container } = render(
      <NativeChatMessageList
        session={sessionWith([messageWith('assistant', 'a1', FENCED_CODE)])}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
        onLinkClick={() => {}}
      />
    )

    expect(container.querySelector('.native-chat-code')).not.toBeNull()
  })

  it('colors a fenced code block in a user message (the other call site)', () => {
    const { container } = render(
      <NativeChatMessageList
        session={sessionWith([messageWith('user', 'u1', FENCED_CODE)])}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
        onLinkClick={() => {}}
      />
    )

    expect(container.querySelector('.native-chat-code')).not.toBeNull()
    expect(container.querySelectorAll('[class*="hljs"]').length).toBeGreaterThan(0)
  })

  it('colors inline code in chat prose with the code-accent classes', () => {
    const { container } = render(
      <NativeChatMessageList
        session={sessionWith([messageWith('assistant', 'a1', 'see `inlineCode` here')])}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
        onLinkClick={() => {}}
      />
    )

    const inlineCode = container.querySelector('code.text-code-accent')
    expect(inlineCode).not.toBeNull()
    expect(inlineCode).toHaveClass('bg-code-accent-surface')
  })

  it('still colors code when onLinkClick is omitted (the falsy-handler production path)', () => {
    const { container } = render(
      <NativeChatMessageList
        session={sessionWith([messageWith('assistant', 'a1', FENCED_CODE)])}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(container.querySelector('.native-chat-code')).not.toBeNull()
    expect(container.querySelectorAll('[class*="hljs"]').length).toBeGreaterThan(0)
  })
  it('uses the chat user surface for user message bubbles', () => {
    const { container } = render(
      <NativeChatMessageList
        session={sessionWith([messageWith('user', 'u1', 'hello')])}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(container.querySelector('.bg-chat-user-surface')).not.toBeNull()
  })

  it('uses the tool-search border color for reasoning messages', () => {
    const { container } = render(
      <NativeChatMessageList
        session={sessionWith([messageWith('reasoning', 'r1', 'thinking')])}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(container.querySelector('.border-l-2')?.className).toContain(
      '[border-left-color:color-mix(in_srgb,var(--tool-search)_55%,transparent)]'
    )
  })
})
