import type { ComponentProps } from 'react'
import { NativeChatMessageList } from '../NativeChatMessageList'
import { NativeChatReadErrorNotice } from './NativeChatReadErrorNotice'

type NativeChatConversationProps = Omit<
  ComponentProps<typeof NativeChatMessageList>,
  'expandSignal'
> & {
  readError?: string
}

/** The message list plus, when the transcript read is failing, the inline
 *  notice above it. Split out so the view file dispatches surfaces only. */
export function NativeChatConversation({
  readError,
  ...listProps
}: NativeChatConversationProps): React.JSX.Element {
  return (
    <>
      {readError ? <NativeChatReadErrorNotice message={readError} /> : null}
      <NativeChatMessageList {...listProps} expandSignal={false} />
    </>
  )
}
