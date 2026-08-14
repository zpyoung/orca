import React from 'react'
import { Eye, Globe, Pencil, Search, Terminal } from 'lucide-react'
import type { NativeChatToolCategory } from '../../../../shared/native-chat-tool-category'

/**
 * Renderer-local presentation (icon, text color, dot color) for each tool
 * category. Kept separate from the shared name→category mapping so other
 * renderers — e.g. mobile — can supply their own icons for the same
 * categories without touching the classification logic.
 */

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

export function nativeChatToolCategoryGlyph(
  category: NativeChatToolCategory
): React.ComponentType<{ className?: string }> {
  return GLYPH_BY_CATEGORY[category]
}

export function nativeChatToolCategoryClassName(category: NativeChatToolCategory): string {
  return TEXT_CLASS_BY_CATEGORY[category]
}

export function nativeChatToolCategoryDotClassName(category: NativeChatToolCategory): string {
  return DOT_CLASS_BY_CATEGORY[category]
}
