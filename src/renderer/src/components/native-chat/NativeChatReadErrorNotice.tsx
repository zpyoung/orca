import { TriangleAlert } from 'lucide-react'
import { translate } from '@/i18n/i18n'

/** Inline "the transcript read is failing" strip shown above a conversation that
 *  still has content. The full-pane error surface would hide messages the user
 *  can already read — including the send they just made. */
export function NativeChatReadErrorNotice({ message }: { message: string }): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex items-start gap-2 border-b border-border bg-destructive/10 px-3 py-2 text-xs text-destructive"
    >
      <TriangleAlert className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 flex-1">
        {translate(
          'components.native-chat.state.readErrorNotice',
          'Chat history could not be refreshed. {{value0}}',
          { value0: message }
        )}
      </span>
    </div>
  )
}
