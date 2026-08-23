import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

/**
 * Copies an approval's tool input so a long command can be pasted into a
 * terminal and read there before it is allowed. Goes through Electron's
 * clipboard IPC, which navigator.clipboard's silent failures in some renderer
 * contexts make necessary. `truncated` renames the action rather than blocking
 * it — a cut command is still worth pasting, but must not be offered as whole.
 */
export function ApprovalInputCopyButton({
  text,
  truncated
}: {
  text: string
  truncated?: boolean
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current)
      }
    },
    []
  )

  const handleCopy = useCallback(async () => {
    try {
      await window.api.ui.writeClipboardText(text)
      setCopied(true)
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current)
      }
      resetTimerRef.current = window.setTimeout(() => {
        resetTimerRef.current = null
        setCopied(false)
      }, 1500)
    } catch {
      /* best-effort: clipboard can reject when unfocused */
    }
  }, [text])

  const label = copied
    ? translate('components.native-chat.approval.copied', 'Copied')
    : truncated
      ? translate('components.native-chat.approval.copyTruncated', 'Copy truncated text')
      : translate('components.native-chat.approval.copy', 'Copy to clipboard')

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        copied && 'text-status-success'
      )}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}
