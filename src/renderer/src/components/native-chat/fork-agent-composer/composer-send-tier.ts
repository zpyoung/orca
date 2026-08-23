import type { TuiAgent } from '../../../../../shared/tui-agent'

export type ComposerSendTier = 'verified' | 'input'

/** Agents whose TUI prompt geometry the native-chat glyph recognizers
 *  (`COMPOSER_PROMPT_LINE` in native-chat-launch-draft-send.ts) cover, so a
 *  send can be confirmed by reading the screen back rather than trusting a
 *  blind clear. Adding an agent here requires a matching recognizer. */
export const COMPOSER_VERIFIED_TIER_AGENTS: ReadonlySet<TuiAgent> = new Set<TuiAgent>([
  'claude',
  'openclaude',
  'codex'
])

/**
 * Decides whether a composer send can rely on precise screen read-back
 * (`verified`) or must fall back to the blind slack-heuristic clear
 * (`input`). Independent of card-tier support: an agent may render an
 * interactive native-chat card yet still lack a verified-tier recognizer.
 */
export function resolveComposerSendTier(
  agent: TuiAgent,
  ctx: { isLocalConptyBelowWrapMarkers: boolean }
): ComposerSendTier {
  if (ctx.isLocalConptyBelowWrapMarkers) {
    return 'input'
  }
  return COMPOSER_VERIFIED_TIER_AGENTS.has(agent) ? 'verified' : 'input'
}
