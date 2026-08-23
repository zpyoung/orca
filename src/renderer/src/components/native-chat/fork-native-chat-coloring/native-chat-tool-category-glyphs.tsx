import React from 'react'
import { Eye, Globe, Pencil, Search, Terminal } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  categorizeNativeChatTool,
  type NativeChatToolCategory
} from '../../../../../shared/fork-native-chat-coloring/native-chat-tool-category'
import { isToolCallBlock, type NativeChatBlock } from '../../../../../shared/native-chat-types'

const GLYPH_BY_CATEGORY: Record<
  NativeChatToolCategory,
  React.ComponentType<{ className?: string }>
> = {
  read: Eye,
  write: Pencil,
  exec: Terminal,
  search: Search,
  net: Globe
}

const TEXT_CLASS_BY_CATEGORY: Record<NativeChatToolCategory, string> = {
  read: 'text-tool-read',
  write: 'text-tool-write',
  exec: 'text-tool-exec',
  search: 'text-tool-search',
  net: 'text-tool-net'
}

const DOT_CLASS_BY_CATEGORY: Record<NativeChatToolCategory, string> = {
  read: 'bg-tool-read',
  write: 'bg-tool-write',
  exec: 'bg-tool-exec',
  search: 'bg-tool-search',
  net: 'bg-tool-net'
}

export function NativeChatToolName({ name }: { name: string }): React.JSX.Element {
  const category = categorizeNativeChatTool(name)
  const Glyph = category ? GLYPH_BY_CATEGORY[category] : null

  return (
    <>
      {category && Glyph ? (
        <Glyph
          className={cn('size-3.5 shrink-0', TEXT_CLASS_BY_CATEGORY[category])}
          aria-hidden="true"
          data-tool-category-glyph={category}
        />
      ) : null}
      <code
        className={cn(
          'shrink-0 font-mono text-xs font-semibold transition-colors',
          category
            ? TEXT_CLASS_BY_CATEGORY[category]
            : 'text-foreground/90 group-hover:text-foreground'
        )}
      >
        {name}
      </code>
    </>
  )
}

export function NativeChatToolCategoryDots({
  blocks
}: {
  blocks: NativeChatBlock[]
}): React.JSX.Element {
  const categories = distinctToolCategories(blocks)

  return (
    <>
      {categories.map((category) => (
        <span
          key={category}
          aria-hidden="true"
          data-tool-category-dot={category}
          className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASS_BY_CATEGORY[category])}
        />
      ))}
    </>
  )
}

function distinctToolCategories(blocks: NativeChatBlock[]): NativeChatToolCategory[] {
  const seen = new Set<NativeChatToolCategory>()
  for (const block of blocks) {
    if (!isToolCallBlock(block)) {
      continue
    }
    const category = categorizeNativeChatTool(block.name)
    if (category) {
      seen.add(category)
    }
  }
  return Array.from(seen)
}
