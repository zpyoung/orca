// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../shared/native-chat-types'
import { NativeChatMessageList } from '../NativeChatMessageList'
import type { NativeChatLiveSession } from '../use-native-chat-live-session'
import { installNativeChatMessageListTestViewport } from '../native-chat-message-list-test-viewport'

vi.mock('@/lib/syntax-highlighting/oniguruma', async () => ({
  loadOniguruma: (await import('@/lib/syntax-highlighting/oniguruma-test-harness'))
    .loadNodeOniguruma
}))

// Chat code fences are colored by upstream's TextMate highlighter, which tokenizes after mount
// and carries each token's theme colors as custom properties.
const COLORED_TOKENS = 'span[style*="--syntax-dark"]'

afterEach(cleanup)

// The list windows its rows, so happy-dom's zero-height viewport mounts none of them.
let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())

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
    olderHistoryGeneration: 0,
    loadEarlier: () => Promise.resolve('exhausted'),
    readPhase: 'ready'
  }
}

describe('NativeChatMessageList code coloring', () => {
  it('colors a fenced code block in an assistant message with syntax token colors', async () => {
    const { container } = render(
      <NativeChatMessageList
        session={sessionWith([messageWith('assistant', 'a1', FENCED_CODE)])}
        isWorking={false}
        expandSignal={false}
        onLinkClick={() => {}}
      />
    )

    await waitFor(
      () => expect(container.querySelectorAll(COLORED_TOKENS).length).toBeGreaterThan(0),
      { timeout: 10_000 }
    )
  })

  it('marks the markdown wrapper with the native-chat-code class the stylesheet targets', () => {
    const { container } = render(
      <NativeChatMessageList
        session={sessionWith([messageWith('assistant', 'a1', FENCED_CODE)])}
        isWorking={false}
        expandSignal={false}
        onLinkClick={() => {}}
      />
    )

    expect(container.querySelector('.native-chat-code')).not.toBeNull()
  })

  it('colors a fenced code block in a user message (the other call site)', async () => {
    const { container } = render(
      <NativeChatMessageList
        session={sessionWith([messageWith('user', 'u1', FENCED_CODE)])}
        isWorking={false}
        expandSignal={false}
        onLinkClick={() => {}}
      />
    )

    expect(container.querySelector('.native-chat-code')).not.toBeNull()
    await waitFor(
      () => expect(container.querySelectorAll(COLORED_TOKENS).length).toBeGreaterThan(0),
      { timeout: 10_000 }
    )
  })

  it('colors inline code in chat prose with the code-accent classes', () => {
    const { container } = render(
      <NativeChatMessageList
        session={sessionWith([messageWith('assistant', 'a1', 'see `inlineCode` here')])}
        isWorking={false}
        expandSignal={false}
        onLinkClick={() => {}}
      />
    )

    const inlineCode = container.querySelector('code.text-code-accent')
    expect(inlineCode).not.toBeNull()
    expect(inlineCode).toHaveClass('bg-code-accent-surface')
  })

  it('still colors code when onLinkClick is omitted (the falsy-handler production path)', async () => {
    const { container } = render(
      <NativeChatMessageList
        session={sessionWith([messageWith('assistant', 'a1', FENCED_CODE)])}
        isWorking={false}
        expandSignal={false}
      />
    )

    expect(container.querySelector('.native-chat-code')).not.toBeNull()
    await waitFor(
      () => expect(container.querySelectorAll(COLORED_TOKENS).length).toBeGreaterThan(0),
      { timeout: 10_000 }
    )
  })
  it('uses the chat user surface for user message bubbles', () => {
    const { container } = render(
      <NativeChatMessageList
        session={sessionWith([messageWith('user', 'u1', 'hello')])}
        isWorking={false}
        expandSignal={false}
      />
    )

    expect(container.querySelector('.bg-chat-user-surface')).not.toBeNull()
  })
})
