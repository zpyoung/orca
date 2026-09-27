import { useMemo } from 'react'
import { MessageCircleQuestionMark } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { selectPaneAskQueue } from '@/store/slices/fork-ask-question-tool/asks'
import { isTerminalAskStatus } from '../../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type { ActivityBarItem } from '../activity-bar-buttons'
import { useFocusedPaneKey } from '../fork-session-info/focused-session-info'

const NO_ITEMS: ActivityBarItem[] = []

/**
 * The Questions activity item, present only while the focused session has an ask. Returns an
 * array so the call site spreads it — an absent item must not leave a hole in the rail.
 *
 * The item stays for the whole queue, resolved entries included, so the result summary that
 * flashes for `ASK_DISMISS_DELAY_MS` has somewhere to render before the item disappears.
 */
export function useAskActivityItems(): ActivityBarItem[] {
  const paneKey = useFocusedPaneKey()
  const hasAsks = useAppStore((state) => selectPaneAskQueue(state, paneKey).length > 0)
  const isAwaitingAnswer = useAppStore((state) =>
    selectPaneAskQueue(state, paneKey).some((card) => !isTerminalAskStatus(card.status))
  )

  return useMemo(
    () =>
      hasAsks
        ? [
            {
              id: 'ask' as const,
              icon: MessageCircleQuestionMark,
              title: translate('components.fork-ask-question-tool.askPanel.title', 'Questions'),
              shortcut: '',
              // The dot tracks answerability, not presence, so it clears the moment the
              // question is answered rather than lingering through the result flash.
              ...(isAwaitingAnswer ? { statusIndicator: 'pending' as const } : {})
            }
          ]
        : NO_ITEMS,
    [hasAsks, isAwaitingAnswer]
  )
}
