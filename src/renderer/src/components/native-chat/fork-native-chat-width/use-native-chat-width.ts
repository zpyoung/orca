import { useAppStore } from '../../../store'
import { nativeChatWidthClassName, resolveNativeChatWidthTier } from './native-chat-width'
import type { NativeChatWidthTier } from '../../../../../shared/fork-native-chat-width/native-chat-width-tier'

/**
 * The globally-configured native chat reading-column tier. Every read of
 * `settings.nativeChatWidth` goes through here so the resolver's fallback (for
 * settings still loading, or a persisted blob written before this setting
 * existed) can't be bypassed at a call site.
 */
export function useNativeChatWidthTier(): NativeChatWidthTier {
  return useAppStore((s) => resolveNativeChatWidthTier(s.settings?.nativeChatWidth))
}

/**
 * Tailwind max-width token for the configured tier, for the centered reading
 * column shared by the transcript, composer, and interactive cards. Because the
 * setting is global, every column subscribes to the same store slice and no
 * width value is threaded through props.
 */
export function useNativeChatWidthClassName(): string {
  return useAppStore((s) =>
    nativeChatWidthClassName(resolveNativeChatWidthTier(s.settings?.nativeChatWidth))
  )
}
