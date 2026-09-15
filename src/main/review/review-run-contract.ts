import type { ReviewDepth, ReviewProfile, RunRecord } from '../../shared/review/stage-schemas'
import type { DirEntry } from '../../shared/types'

export const MAX_REVIEW_RUNS_PER_WORKSPACE = 20

export type ReviewFilesystem = {
  createDir(path: string): Promise<void>
  readDir(path: string): Promise<DirEntry[]>
  readFile(path: string): Promise<{ content: string }>
  writeFile(path: string, content: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  deletePath(path: string, recursive?: boolean): Promise<void>
  stat(path: string): Promise<unknown>
}

export type ReviewWorkspace = {
  id: string
  rootPath: string
  filesystem: ReviewFilesystem
}

export type ReviewRunCreateInput = {
  depth?: ReviewDepth
  profile?: ReviewProfile
  orchestrationRunId?: string
  driverTerminalHandle?: string
}

export type ReviewRunShowResult = {
  found: true
  run: RunRecord
  manifest?: unknown
  stale?: boolean
}

export type ReviewStalenessResult = {
  run: string
  stale: boolean
  available: boolean
  reason?: string
  checkedAt: string
}
