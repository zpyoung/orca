/** Pure width-tier logic for the desktop native chat view — the horizontal
 *  counterpart to `native-chat-font-scale`. Every centered reading column in the
 *  chat surface (transcript, composer, question and approval cards) resolves its
 *  max-width through here so the four sites can never disagree. Kept DOM-free
 *  and React-free so it can be unit-tested. */

import type { NativeChatWidthTier } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

/** Ordered narrow -> full; both the Settings select and the header menu render
 *  tiers in this order so the two controls never disagree on ordering. */
export const NATIVE_CHAT_WIDTH_TIERS: readonly NativeChatWidthTier[] = [
  'narrow',
  'comfortable',
  'wide',
  'full'
]

export const DEFAULT_NATIVE_CHAT_WIDTH_TIER: NativeChatWidthTier = 'comfortable'

/** Class names are literals, never interpolated — Tailwind's JIT only emits a
 *  utility it can find by static scan. */
const WIDTH_CLASS_BY_TIER: Record<NativeChatWidthTier, string> = {
  narrow: 'max-w-2xl',
  comfortable: 'max-w-4xl',
  wide: 'max-w-6xl',
  full: 'max-w-none'
}

export function nativeChatWidthClassName(tier: NativeChatWidthTier): string {
  return WIDTH_CLASS_BY_TIER[tier]
}

/** Single fallback point for two distinct cases: settings are `null` until
 *  `fetchSettings()` resolves, and a persisted blob written before this setting
 *  existed (or hand-edited) carries no valid tier. Nothing in the write path
 *  validates this field, so every read site goes through here. */
export function resolveNativeChatWidthTier(
  value: NativeChatWidthTier | null | undefined
): NativeChatWidthTier {
  return value && NATIVE_CHAT_WIDTH_TIERS.includes(value) ? value : DEFAULT_NATIVE_CHAT_WIDTH_TIER
}

/** Keys stay literal per tier rather than interpolated: the localization catalog
 *  verifier only collects `translate()` calls it can read statically, so a
 *  templated key would never reach the non-English catalogs. */
const WIDTH_LABEL_BY_TIER: Record<NativeChatWidthTier, () => string> = {
  narrow: () => translate('components.native-chat.width.tier.narrow', 'Narrow'),
  comfortable: () => translate('components.native-chat.width.tier.comfortable', 'Comfortable'),
  wide: () => translate('components.native-chat.width.tier.wide', 'Wide'),
  full: () => translate('components.native-chat.width.tier.full', 'Full')
}

/** Both controls label tiers through here so the Settings select and the header
 *  menu can never drift apart. */
export function nativeChatWidthTierLabel(tier: NativeChatWidthTier): string {
  return WIDTH_LABEL_BY_TIER[tier]()
}
