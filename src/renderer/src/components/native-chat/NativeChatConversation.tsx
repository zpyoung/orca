import { NativeChatMessageList } from './NativeChatMessageList'
import { NativeChatReadErrorNotice } from './NativeChatReadErrorNotice'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import type { NativeChatLiveSession } from './use-native-chat-live-session'

/** The message list plus, when the transcript read is failing, the inline
 *  notice above it. Split out so the view file dispatches surfaces only. */
export function NativeChatConversation({
  session,
  isWorking,
  fontScale,
  onLinkClick,
  allowFileUriLinks,
  failedDeliveryMessageIds,
  readError
}: {
  session: NativeChatLiveSession
  isWorking: boolean
  fontScale: number
  onLinkClick?: CommentMarkdownLinkClickHandler
  allowFileUriLinks: boolean
  failedDeliveryMessageIds?: ReadonlySet<string>
  readError?: string
}): React.JSX.Element {
  return (
    <>
      {readError ? <NativeChatReadErrorNotice message={readError} /> : null}
      <NativeChatMessageList
        session={session}
        isWorking={isWorking}
        expandSignal={false}
        fontScale={fontScale}
        onLinkClick={onLinkClick}
        allowFileUriLinks={allowFileUriLinks}
        failedDeliveryMessageIds={failedDeliveryMessageIds}
      />
    </>
  )
}
