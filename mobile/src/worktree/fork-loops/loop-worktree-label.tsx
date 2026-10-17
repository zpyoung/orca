import { StyleSheet, Text } from 'react-native'
import type { LoopWorktreeSummary, PauseReason } from '../../../../src/shared/fork-loops/loop-types'
import { colors } from '../../theme/mobile-theme'

const PAUSE_REASON_TEXT: Record<PauseReason, string> = {
  user: 'paused by you',
  'cap-iterations': 'iteration cap reached',
  'cap-time': 'time cap reached',
  'cap-cost': 'cost cap reached',
  'no-progress': 'no progress',
  'protected-path': 'touched a protected path',
  'agent-blocked': 'agent blocked',
  'agent-decide': 'agent needs a decision',
  crashed: 'agent kept crashing',
  'usage-limit': 'usage limit reached',
  'interrupted-by-restart': 'interrupted by restart',
  unverifiable: 'lost contact with host',
  'ask-before-next': 'waiting for your OK',
  'queue-exhausted': 'queue is empty'
}

const PAUSE_REASON_LOOKUP = new Map<string, string>(Object.entries(PAUSE_REASON_TEXT))

// hosts newer than this client may send reasons it has no text for
function describePauseReason(reason: string): string {
  return PAUSE_REASON_LOOKUP.get(reason) ?? reason.replaceAll('-', ' ')
}

function describeLoopState({ state, pauseReason }: LoopWorktreeSummary['primary']): string {
  if (state === 'needs-you') {
    return 'needs you'
  }
  if (state === 'paused' && pauseReason) {
    return `paused: ${describePauseReason(pauseReason)}`
  }
  return state
}

/** The one-line loop status shown on a worktree row, e.g. `Loop 3/10 · running`. */
export function formatLoopWorktreeLabel(loop: LoopWorktreeSummary): string {
  const { iterationsCompleted, maxIterations } = loop.primary
  const progress =
    maxIterations === undefined
      ? `${iterationsCompleted}`
      : `${iterationsCompleted}/${maxIterations}`
  return `Loop ${progress} · ${describeLoopState(loop.primary)}`
}

/** Renders nothing when the host sent no loop, so older hosts show the row unchanged. */
export function LoopWorktreeLabel({ loop }: { loop: LoopWorktreeSummary | undefined }) {
  if (!loop) {
    return null
  }
  return (
    <Text style={styles.label} numberOfLines={1}>
      {formatLoopWorktreeLabel(loop)}
    </Text>
  )
}

const styles = StyleSheet.create({
  label: {
    fontSize: 10,
    color: colors.textMuted,
    marginTop: 2
  }
})
