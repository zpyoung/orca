import { useMemo } from 'react'
import type { NativeChatMessage, NativeChatSession } from '../../../../shared/native-chat-types'
import type { NativeChatLaunchPrompt } from '@/lib/native-chat-launch-prompt'
import { launchPromptAsMessage } from './native-chat-pending'

/**
 * Overlay the pane's launch prompt as an optimistic user turn until the
 * transcript's own copy of it lands, so a launched conversation shows the
 * prompt that started it instead of an empty pane.
 */
export function useNativeChatLaunchPromptOverlay<T extends NativeChatSession>(
  paneLaunchPrompt: NativeChatLaunchPrompt | null,
  session: T
): { launchPromptMessage: NativeChatMessage | null; sessionWithLaunchPrompt: T } {
  const launchPromptMessage = useMemo(
    () => launchPromptAsMessage(paneLaunchPrompt, session.messages),
    [paneLaunchPrompt, session.messages]
  )
  const sessionWithLaunchPrompt = useMemo<T>(() => {
    if (!launchPromptMessage) {
      return session
    }
    return { ...session, messages: [...session.messages, launchPromptMessage] }
  }, [launchPromptMessage, session])
  return { launchPromptMessage, sessionWithLaunchPrompt }
}
