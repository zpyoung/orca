import { StyleSheet, Text } from 'react-native'
import type { LoopWorktreeSummary } from '../../../../src/shared/fork-loops/loop-types'
import { colors } from '../../theme/mobile-theme'

function describeLoopState({ state, pauseReason }: LoopWorktreeSummary['primary']): string {
  if (state === 'needs-you') {
    return 'needs you'
  }
  if (state === 'paused' && pauseReason) {
    return `paused: ${pauseReason}`
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
