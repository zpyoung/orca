import type { DirEntry } from '../../shared/filesystem-entry-types'

export function highestEpoch(entries: readonly DirEntry[]): number {
  let highest = 0
  for (const entry of entries) {
    if (!entry.isDirectory || entry.isSymlink) {
      continue
    }
    const match = /^epoch-(\d+)$/.exec(entry.name)
    if (!match) {
      continue
    }
    const epoch = Number(match[1])
    if (Number.isSafeInteger(epoch) && epoch > highest) {
      highest = epoch
    }
  }
  return highest
}
