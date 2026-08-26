export type HistoryState = { entries: readonly string[]; index: number | null }
export const EMPTY_HISTORY: HistoryState = { entries: [], index: null }

/** Per-pane bounds: unlike the scope-key LRU, nothing ever revisits an old
 *  entry within a pane's own history to evict it, so without these a single
 *  long-lived pane retains every sent prompt for the renderer's lifetime. */
export const HISTORY_MAX_ENTRIES = 200
export const HISTORY_MAX_TOTAL_CHARS = 200_000

// Drops oldest entries until both bounds hold, but the just-pushed entry
// (last) is never dropped even if it alone exceeds the character bound —
// otherwise a large pasted prompt would vanish the moment it's sent.
function boundHistoryEntries(entries: readonly string[]): readonly string[] {
  let start = Math.max(0, entries.length - HISTORY_MAX_ENTRIES)
  let totalChars = 0
  for (let i = entries.length - 1; i >= start; i--) {
    totalChars += entries[i].length
  }
  while (totalChars > HISTORY_MAX_TOTAL_CHARS && start < entries.length - 1) {
    totalChars -= entries[start].length
    start++
  }
  return start === 0 ? entries : entries.slice(start)
}

export function pushHistory(history: HistoryState, sent: string): HistoryState {
  if (sent.trim() === '' || history.entries.at(-1) === sent) {
    return { entries: history.entries, index: null }
  }
  return { entries: boundHistoryEntries([...history.entries, sent]), index: null }
}

/** Adds transcript/status prompts once without disturbing live recall state. */
export function seedHistory(history: HistoryState, prompts: readonly string[]): HistoryState {
  const seen = new Set(history.entries)
  let next = history
  for (const prompt of prompts) {
    if (prompt.trim() === '' || seen.has(prompt)) {
      continue
    }
    seen.add(prompt)
    next = pushHistory(next, prompt)
  }
  return next
}

export type HistoryRecall = { history: HistoryState; draft: string | null }

export function recallPrevious(history: HistoryState): HistoryRecall {
  if (history.entries.length === 0) {
    return { history, draft: null }
  }
  const index = history.index === null ? history.entries.length - 1 : Math.max(0, history.index - 1)
  return { history: { entries: history.entries, index }, draft: history.entries[index] }
}

export function recallNext(history: HistoryState): HistoryRecall {
  if (history.index === null) {
    return { history, draft: null }
  }
  const index = history.index + 1
  if (index >= history.entries.length) {
    return { history: { entries: history.entries, index: null }, draft: '' }
  }
  return { history: { entries: history.entries, index }, draft: history.entries[index] }
}
