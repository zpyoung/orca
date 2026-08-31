import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'

const MAX_PATHS_PER_PANE = 5
const MAX_TRACKED_PANES = 256

type PaneTranscriptHistory = {
  /** Newest first; index 0 is the pane's current hook-reported path. */
  transcriptPaths: string[]
  sessionIds: string[]
}

const historyByPaneKey = new Map<string, PaneTranscriptHistory>()

/**
 * Remember the transcript paths a pane's agent has reported, newest first.
 *
 * Claude Code mints a new session id at a turn boundary and reports it — with a
 * transcript path derived from it — before any file exists for it. A handoff
 * taken while the pane sits on that id finds nothing at the reported path and
 * nothing at `<id>.jsonl`, because the conversation is still under the previous
 * id. Only the pane's own earlier reports link the two, so keep them.
 */
export function recordForkPaneTranscriptObservation(
  event: Pick<AgentHookEventPayload, 'paneKey' | 'providerSession'>
): void {
  const paneKey = event.paneKey?.trim()
  const session = event.providerSession
  if (!paneKey || !session) {
    return
  }
  const history = historyByPaneKey.get(paneKey) ?? { transcriptPaths: [], sessionIds: [] }
  // Re-insert so eviction drops the least recently active pane, not the oldest.
  historyByPaneKey.delete(paneKey)
  pushMostRecent(history.transcriptPaths, session.transcriptPath)
  pushMostRecent(history.sessionIds, session.id)
  historyByPaneKey.set(paneKey, history)
  while (historyByPaneKey.size > MAX_TRACKED_PANES) {
    const oldest = historyByPaneKey.keys().next()
    if (oldest.done) {
      break
    }
    historyByPaneKey.delete(oldest.value)
  }
}

/** The pane's reported transcript paths, newest first. */
export function getForkPaneTranscriptPaths(paneKey: string | null | undefined): string[] {
  const history = paneKey ? historyByPaneKey.get(paneKey.trim()) : undefined
  return history ? [...history.transcriptPaths] : []
}

/** Whether some other pane has claimed this session id, so a directory scan must
 *  not hand its transcript to the pane being probed. */
export function isForkSessionClaimedByOtherPane(
  paneKey: string | null | undefined,
  sessionId: string
): boolean {
  const owner = paneKey?.trim() ?? null
  for (const [key, history] of historyByPaneKey) {
    if (key !== owner && history.sessionIds.includes(sessionId)) {
      return true
    }
  }
  return false
}

export function resetForkPaneTranscriptHistory(): void {
  historyByPaneKey.clear()
}

function pushMostRecent(values: string[], value: string | undefined): void {
  const trimmed = value?.trim()
  if (!trimmed) {
    return
  }
  const existing = values.indexOf(trimmed)
  if (existing !== -1) {
    values.splice(existing, 1)
  }
  values.unshift(trimmed)
  values.length = Math.min(values.length, MAX_PATHS_PER_PANE)
}
