import {
  setLocalClaudeSuppressionVerdictReader,
  type ClaudeSuppressionVerdict
} from '../../../../shared/fork-ask-question-tool/claude-suppression-verdict'

type SuppressionVerdictApi = {
  getSuppressionVerdict: () => Promise<ClaudeSuppressionVerdict>
  onSuppressionVerdict: (callback: (verdict: ClaudeSuppressionVerdict) => void) => () => void
}

/**
 * Holds the local suppression verdict main publishes, so a renderer-built Claude launch composes
 * against the same answer main would. The renderer cannot probe a binary itself, so until the
 * first value arrives every launch reads `'pending'` — unsuppressed, exactly as today.
 */
export function wireClaudeSuppressionVerdict(api: SuppressionVerdictApi): () => void {
  let verdict: ClaudeSuppressionVerdict = 'pending'
  let pushed = false
  setLocalClaudeSuppressionVerdictReader(() => verdict)

  const stopListening = api.onSuppressionVerdict((next) => {
    pushed = true
    verdict = next
  })
  void api.getSuppressionVerdict().then(
    (next) => {
      // the initial fetch can land after a push; a late reply must not reinstate the older answer
      if (!pushed) {
        verdict = next
      }
    },
    () => undefined
  )

  return () => {
    setLocalClaudeSuppressionVerdictReader(null)
    stopListening()
  }
}
