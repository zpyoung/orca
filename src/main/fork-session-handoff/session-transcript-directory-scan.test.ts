import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodeClaudeProjectPath } from '../ai-vault/claude-project-dir-encoding'
import { scanForkClaudeProjectTranscript } from './session-transcript-directory-scan'

const workspacePath = '/workspace/repo'
const HOUR_MS = 60 * 60 * 1000

let root: string
let bucket: string

/** Local-host wiring, matching what `resolveForkTranscriptHost` supplies. */
const localHostArgs = {
  joinPath: (dirPath: string, entryName: string) => resolve(dirPath, entryName),
  readDirectory: (dirPath: string) => readdir(dirPath),
  statFile: async (filePath: string) => {
    const stats = await stat(filePath)
    return { isFile: stats.isFile(), modifiedAt: stats.mtimeMs }
  }
}

function write(name: string, modifiedAtMs: number): string {
  const filePath = join(bucket, name)
  writeFileSync(filePath, '{}\n')
  utimesSync(filePath, new Date(modifiedAtMs), new Date(modifiedAtMs))
  return filePath
}

function scan(args: {
  workspacePath?: string
  isClaimedByOtherPane?: (sessionId: string) => boolean
}) {
  return scanForkClaudeProjectTranscript({
    workspacePath: args.workspacePath ?? workspacePath,
    rootDirs: [root],
    isClaimedByOtherPane: args.isClaimedByOtherPane ?? (() => false),
    ...localHostArgs
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'handoff-scan-'))
  bucket = join(root, encodeClaudeProjectPath(workspacePath))
  mkdirSync(bucket, { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('scanForkClaudeProjectTranscript', () => {
  it('returns the newest transcript when the runner-up is an older conversation', async () => {
    write('older.jsonl', Date.now() - 6 * HOUR_MS)
    const newer = write('newer.jsonl', Date.now())
    await expect(scan({})).resolves.toEqual({ path: newer, ambiguous: false })
  })

  it('refuses to choose between two transcripts written moments apart', async () => {
    write('one.jsonl', Date.now() - 30_000)
    write('two.jsonl', Date.now())
    await expect(scan({})).resolves.toEqual({ path: null, ambiguous: true })
  })

  it('resolves when the only competing transcript belongs to another pane', async () => {
    const mine = write('mine.jsonl', Date.now() - 30_000)
    write('claimed.jsonl', Date.now())
    await expect(
      scan({ isClaimedByOtherPane: (sessionId) => sessionId === 'claimed' })
    ).resolves.toEqual({ path: mine, ambiguous: false })
  })

  it('skips a session another pane has claimed', async () => {
    const older = write('older.jsonl', Date.now() - 6 * HOUR_MS)
    write('claimed.jsonl', Date.now())
    await expect(
      scan({ isClaimedByOtherPane: (sessionId) => sessionId === 'claimed' })
    ).resolves.toEqual({ path: older, ambiguous: false })
  })

  it('ignores files that are not transcripts', async () => {
    write('notes.md', Date.now())
    const transcript = write('session.jsonl', Date.now() - 6 * HOUR_MS)
    await expect(scan({})).resolves.toEqual({ path: transcript, ambiguous: false })
  })

  it('reports nothing when the workspace has no bucket', async () => {
    await expect(scan({ workspacePath: '/workspace/never-opened' })).resolves.toEqual({
      path: null,
      ambiguous: false
    })
  })

  it('reports nothing without a workspace path', async () => {
    await expect(scan({ workspacePath: '  ' })).resolves.toEqual({
      path: null,
      ambiguous: false
    })
  })
})
