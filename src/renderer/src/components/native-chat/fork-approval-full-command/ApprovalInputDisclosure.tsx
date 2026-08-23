import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { ChatApproval } from '../native-chat-interactive-prompt'
import { ApprovalInputCopyButton } from './ApprovalInputCopyButton'

function toggleLabel(isCommand: boolean, expanded: boolean, truncated: boolean): string {
  if (truncated) {
    return isCommand
      ? expanded
        ? translate('components.native-chat.approval.hideCommand', 'Hide command')
        : translate('components.native-chat.approval.showCommand', 'Show command')
      : expanded
        ? translate('components.native-chat.approval.hideInput', 'Hide input')
        : translate('components.native-chat.approval.showInput', 'Show input')
  }
  return isCommand
    ? expanded
      ? translate('components.native-chat.approval.hideFullCommand', 'Hide full command')
      : translate('components.native-chat.approval.showFullCommand', 'Show full command')
    : expanded
      ? translate('components.native-chat.approval.hideFullInput', 'Hide full input')
      : translate('components.native-chat.approval.showFullInput', 'Show full input')
}

/**
 * The approval card's tool-input region: the host's one-line preview, plus an
 * in-place expander to the input at full length. Nothing about a command should
 * have to be taken on faith at the moment it is allowed.
 *
 * Two clips can still shorten what arrives — the host's own envelope cap and the
 * relay compacting the frame to fit — so whenever `fullLength` exceeds what is
 * on screen the labels drop the word "full" and the region states the shortfall
 * outright. A reader who is about to grant a command must never be shown a
 * partial one under a label promising the whole thing.
 */
export function ApprovalInputDisclosure({
  approval
}: {
  approval: ChatApproval
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()

  const { detail, full, fullField, fullLength } = approval
  if (!detail) {
    return null
  }

  // The relay compacts every presentational field to one shared limit, so a
  // hard-squeezed frame can leave `full` no longer than the preview beside it —
  // no expander to offer, and the preview itself is then the clipped text.
  const shown = full && full !== detail ? full : undefined
  const text = shown ?? detail
  const truncated = fullLength !== undefined && fullLength > text.length

  return (
    <div className="mt-0.5 flex flex-col gap-1">
      {expanded && shown ? (
        <pre
          id={bodyId}
          className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-accent p-2 font-mono text-xs text-foreground/80 scrollbar-sleek"
        >
          {shown}
        </pre>
      ) : (
        <p className="break-words font-mono text-xs text-muted-foreground">{detail}</p>
      )}
      {truncated && (expanded || shown === undefined) ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'components.native-chat.approval.truncatedNote',
            'Truncated — showing {{value0}} of {{value1}} characters.',
            { value0: text.length.toLocaleString(), value1: fullLength.toLocaleString() }
          )}
        </p>
      ) : null}
      <div className="flex items-center gap-1">
        {shown ? (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls={expanded ? bodyId : undefined}
            className="group flex items-center gap-1 rounded-md py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              className={cn('size-3.5 transition-transform', expanded && 'rotate-90')}
            />
            {toggleLabel(fullField === 'command', expanded, truncated)}
          </button>
        ) : null}
        <ApprovalInputCopyButton text={text} truncated={truncated} />
      </div>
    </div>
  )
}
