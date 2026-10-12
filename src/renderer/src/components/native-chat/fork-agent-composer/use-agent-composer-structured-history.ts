import { useMemo, type Dispatch, type SetStateAction } from 'react'
import type { NativeChatStructuredComposerTransport } from '../native-chat-composer-types'
import { pushHistory, type HistoryState } from './agent-composer-history'

/**
 * The structured transport as the composer's send path sees it: every message or
 * host command the host accepts is also recorded in the pane's composer history,
 * as a PTY send is, so Up recalls it.
 */
export function useAgentComposerStructuredHistory(
  structuredTransport: NativeChatStructuredComposerTransport | undefined,
  setHistory: Dispatch<SetStateAction<HistoryState>>
): NativeChatStructuredComposerTransport | undefined {
  return useMemo(() => {
    if (!structuredTransport) {
      return undefined
    }
    return {
      ...structuredTransport,
      dispatchCommand: async (text) => {
        const outcome = await structuredTransport.dispatchCommand(text)
        if (outcome.handled && outcome.accepted) {
          setHistory((previous) => pushHistory(previous, text))
        }
        return outcome
      },
      send: (text, attachments) => {
        const admission = structuredTransport.send(text, attachments)
        if (admission !== false) {
          setHistory((previous) => pushHistory(previous, text))
        }
        return admission
      }
    }
  }, [setHistory, structuredTransport])
}
