import { cn } from '@/lib/utils'
import type { ComposerMarkdownSpanKind } from './composer-markdown-spans'

export const COMPOSER_TEXT_CLASS = 'block w-full px-2 py-1 text-sm'

export const COMPOSER_MARKDOWN_KIND_CLASS: Readonly<Record<ComposerMarkdownSpanKind, string>> = {
  plain: '',
  marker: 'text-muted-foreground/50',
  bold: '[text-shadow:0.35px_0_0_currentColor]',
  italic: 'underline decoration-dotted decoration-muted-foreground/70 underline-offset-2',
  strike: 'line-through',
  code: 'rounded-sm bg-code-accent-surface text-code-accent',
  fence: 'bg-code-accent-surface text-code-accent',
  heading: '[text-shadow:0.35px_0_0_currentColor]',
  quote: 'text-muted-foreground',
  'list-marker': 'text-muted-foreground/70',
  'link-text': 'text-code-accent underline underline-offset-2',
  'link-url': 'text-code-accent/70 underline underline-offset-2',
  mention: 'text-code-accent',
  command: 'text-code-accent',
  skill: 'text-code-accent'
}

const CLASS_PRIORITY: readonly ComposerMarkdownSpanKind[] = [
  'plain',
  'heading',
  'quote',
  'list-marker',
  'bold',
  'italic',
  'strike',
  'link-text',
  'link-url',
  'mention',
  'command',
  'skill',
  'code',
  'fence',
  'marker'
]

/** Combines a span's visual roles while keeping syntax markers lowest-emphasis. */
export function composerMarkdownSpanClassName(kinds: readonly ComposerMarkdownSpanKind[]): string {
  const active = new Set(kinds)
  return cn(
    CLASS_PRIORITY.filter((kind) => active.has(kind)).map(
      (kind) => COMPOSER_MARKDOWN_KIND_CLASS[kind]
    )
  )
}
