import { memo, useMemo, type RefObject } from 'react'
import { cn } from '@/lib/utils'
import { buildComposerMarkdownOverlaySpans } from './composer-markdown-overlay-spans'
import { COMPOSER_TEXT_CLASS, composerMarkdownSpanClassName } from './composer-markdown-style'
import { useComposerScrollSync } from './use-composer-scroll-sync'

type ComposerMarkdownOverlayProps = {
  text: string
  layout?: 'dock'
  disabled: boolean
  textareaRef: RefObject<HTMLTextAreaElement | null>
}

/** Renders a metric-preserving Markdown mirror without changing the submitted draft. */
export const ComposerMarkdownOverlay = memo(function ComposerMarkdownOverlay({
  text,
  layout,
  disabled,
  textareaRef
}: ComposerMarkdownOverlayProps): React.JSX.Element {
  const spans = useMemo(() => buildComposerMarkdownOverlaySpans(text), [text])
  const overlayRef = useComposerScrollSync(textareaRef, text)

  return (
    <div
      ref={overlayRef}
      aria-hidden="true"
      data-composer-markdown-overlay="true"
      style={{ scrollbarColor: 'transparent transparent' }}
      className={cn(
        COMPOSER_TEXT_CLASS,
        'scrollbar-sleek pointer-events-none absolute inset-0 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words text-foreground',
        '[&::-webkit-scrollbar-thumb]:!bg-transparent',
        layout === 'dock' ? 'min-h-0' : 'min-h-12 max-h-[calc(8lh+0.5rem)] pointer-coarse:min-h-14',
        disabled && 'opacity-50'
      )}
    >
      {spans.map((span) => (
        <span
          key={`${span.start}:${span.end}`}
          data-markdown-kinds={span.kinds.join(' ')}
          className={composerMarkdownSpanClassName(span.kinds)}
        >
          {text.slice(span.start, span.end)}
        </span>
      ))}
      {text.endsWith('\n') ? '\n' : null}
    </div>
  )
})
