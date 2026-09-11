import { encodeClaudeProjectPaths } from '../ai-vault/claude-project-dir-encoding'
import type { ForkTranscriptStat } from './session-transcript-host'

/** Two transcripts written this close together are both plausibly a live
 *  conversation, and mtime alone cannot say which pane owns either. */
const COMPETING_TRANSCRIPT_WINDOW_MS = 5 * 60 * 1000

export type ScanForkClaudeProjectArgs = {
  workspacePath: string
  rootDirs: readonly string[]
  isClaimedByOtherPane: (sessionId: string) => boolean
  joinPath: (dirPath: string, entryName: string) => string
  readDirectory: (dirPath: string) => Promise<string[]>
  statFile: (filePath: string) => Promise<ForkTranscriptStat>
}

export type ForkProjectScanResult = {
  /** Null when the bucket held nothing, or when `ambiguous` withheld a match. */
  path: string | null
  /** A second unclaimed transcript was written close enough to the newest that
   *  neither can be attributed to the source pane. */
  ambiguous: boolean
}

/**
 * Last-resort recovery: the newest Claude transcript in the project bucket for
 * `workspacePath`, skipping any session another pane has claimed.
 *
 * Reached only when the pane's own reported paths have all gone, so the bucket
 * is all the evidence there is — a pane this process never observed cannot be
 * excluded by the claim check. Two transcripts written within
 * `COMPETING_TRANSCRIPT_WINDOW_MS` of each other are therefore reported as
 * ambiguous rather than resolved, so a second live pane on the same workspace
 * yields "could not verify" instead of another conversation's transcript. An
 * older, dead conversation does not compete and does not block recovery.
 */
export async function scanForkClaudeProjectTranscript(
  args: ScanForkClaudeProjectArgs
): Promise<ForkProjectScanResult> {
  const workspacePath = args.workspacePath.trim()
  if (!workspacePath) {
    return { path: null, ambiguous: false }
  }
  const bucketNames = encodeClaudeProjectPaths(workspacePath)

  const candidates: { path: string; modifiedAt: number }[] = []
  for (const rootDir of args.rootDirs) {
    for (const bucketName of bucketNames) {
      const bucketDir = args.joinPath(rootDir, bucketName)
      let entries: string[]
      try {
        entries = await args.readDirectory(bucketDir)
      } catch {
        continue
      }
      for (const entry of entries) {
        const sessionId = transcriptSessionId(entry)
        if (!sessionId || args.isClaimedByOtherPane(sessionId)) {
          continue
        }
        const candidate = args.joinPath(bucketDir, entry)
        try {
          const stats = await args.statFile(candidate)
          if (stats.isFile) {
            candidates.push({ path: candidate, modifiedAt: stats.modifiedAt })
          }
        } catch {
          continue
        }
      }
    }
  }

  const [newest, runnerUp] = candidates.sort((left, right) => right.modifiedAt - left.modifiedAt)
  if (!newest) {
    return { path: null, ambiguous: false }
  }
  const ambiguous = Boolean(
    runnerUp && newest.modifiedAt - runnerUp.modifiedAt <= COMPETING_TRANSCRIPT_WINDOW_MS
  )
  return { path: ambiguous ? null : newest.path, ambiguous }
}

/** The `<id>.jsonl` stem, or null for anything else in the bucket. */
function transcriptSessionId(entryName: string): string | null {
  const dot = entryName.lastIndexOf('.')
  if (dot <= 0 || entryName.slice(dot).toLowerCase() !== '.jsonl') {
    return null
  }
  return entryName.slice(0, dot)
}
