import { cn } from '@/lib/utils'
import {
  categorizeNativeChatTool,
  type NativeChatToolCategory
} from '../../../../../shared/fork-native-chat-coloring/native-chat-tool-category'
import { isToolCallBlock, type NativeChatBlock } from '../../../../../shared/native-chat-types'

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

/** The category's text color for a recognized tool name, else undefined so the row keeps upstream's. */
export function nativeChatToolCategoryTextClass(name: string): string | undefined {
  const category = categorizeNativeChatTool(name)
  return category ? TEXT_CLASS_BY_CATEGORY[category] : undefined
}

export function NativeChatToolCategoryDots({
  blocks
}: {
  blocks: NativeChatBlock[]
}): React.JSX.Element | null {
  const categories = distinctToolCategories(blocks)
  if (categories.length === 0) {
    return null
  }

  // One header slot, like upstream's marks, so the dots sit on the summary's first line.
  return (
    <span className="flex h-[1lh] shrink-0 items-center gap-1">
      {categories.map((category) => (
        <span
          key={category}
          aria-hidden="true"
          data-tool-category-dot={category}
          className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASS_BY_CATEGORY[category])}
        />
      ))}
    </span>
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
