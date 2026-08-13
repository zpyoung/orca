export type HistoryState = { entries: readonly string[]; index: number | null }
export const EMPTY_HISTORY: HistoryState = { entries: [], index: null }

export function pushHistory(history: HistoryState, sent: string): HistoryState {
  if (sent.trim() === '' || history.entries.at(-1) === sent) {
    return { entries: history.entries, index: null }
  }
  return { entries: [...history.entries, sent], index: null }
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
