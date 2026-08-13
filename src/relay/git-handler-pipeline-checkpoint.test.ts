import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as childProcess from 'node:child_process'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  const mockedExecFile = vi.fn(actual.execFile)
  // why: promisify(execFile) needs the original's custom-promisify symbol; vi.fn() drops it
  const promisifyCustomKey = Symbol.for('nodejs.util.promisify.custom')
  Object.defineProperty(mockedExecFile, promisifyCustomKey, {
    value: (actual.execFile as unknown as Record<symbol, unknown>)[promisifyCustomKey]
  })
  return { ...actual, execFile: mockedExecFile }
})

import {
  pipelineCheckpointCaptureOp,
  pipelineCheckpointRestoreOp,
  pipelineCheckpointSupportedOp,
  validatePipelineCheckpointCaptureArgs,
  validatePipelineCheckpointRestoreArgs
} from './git-handler-pipeline-checkpoint'

const HEAD_LIKE = 'a'.repeat(40)
const SNAPSHOT_LIKE = 'b'.repeat(40)

describe('pipelineCheckpointSupportedOp', () => {
  it('reports support', async () => {
    await expect(pipelineCheckpointSupportedOp()).resolves.toEqual({ supported: true })
  })
})

describe('validatePipelineCheckpointCaptureArgs', () => {
  const valid = { worktreePath: '/repo', runId: 'run_abc-1', nodeId: 'node-1', attempt: 1 }

  it('accepts well-shaped params', () => {
    expect(validatePipelineCheckpointCaptureArgs(valid)).toEqual(valid)
  })

  it.each([
    ['run-abc', 'runId'],
    ['RUN_abc', 'runId'],
    ['run_abc def', 'runId']
  ])('rejects a malformed runId (%s)', (runId) => {
    expect(() => validatePipelineCheckpointCaptureArgs({ ...valid, runId })).toThrow(/runId/)
  })

  it.each([['Node-1'], ['node_1'], ['']])('rejects a malformed nodeId (%s)', (nodeId) => {
    expect(() => validatePipelineCheckpointCaptureArgs({ ...valid, nodeId })).toThrow(/nodeId/)
  })

  it.each([[0], [-1], [1.5], ['1']])('rejects an invalid attempt (%s)', (attempt) => {
    expect(() => validatePipelineCheckpointCaptureArgs({ ...valid, attempt })).toThrow(/attempt/)
  })

  it('rejects a missing worktreePath', () => {
    expect(() =>
      validatePipelineCheckpointCaptureArgs({ ...valid, worktreePath: undefined })
    ).toThrow(/worktreePath/)
  })
})

describe('validatePipelineCheckpointRestoreArgs', () => {
  const valid = { worktreePath: '/repo', head: HEAD_LIKE, snapshot: SNAPSHOT_LIKE }

  it('accepts well-shaped params', () => {
    expect(validatePipelineCheckpointRestoreArgs(valid)).toEqual(valid)
  })

  it.each([['abc'], ['A'.repeat(40)], ['g'.repeat(40)], [HEAD_LIKE.slice(1)]])(
    'rejects a malformed head (%s)',
    (head) => {
      expect(() => validatePipelineCheckpointRestoreArgs({ ...valid, head })).toThrow(/head/)
    }
  )

  it.each([['refs/heads/main'], ['HEAD'], ['A'.repeat(40)]])(
    'rejects a malformed snapshot (%s)',
    (snapshot) => {
      expect(() => validatePipelineCheckpointRestoreArgs({ ...valid, snapshot })).toThrow(
        /snapshot/
      )
    }
  )
})

describe('rejection happens before any git process runs', () => {
  beforeEach(() => {
    vi.mocked(execFile).mockClear()
  })

  it('never spawns git for a malformed capture request', async () => {
    await expect(
      pipelineCheckpointCaptureOp({
        worktreePath: '/repo',
        runId: 'not valid',
        nodeId: 'node-1',
        attempt: 1
      })
    ).rejects.toThrow(/runId/)
    expect(execFile).not.toHaveBeenCalled()
  })

  it('never spawns git for a malformed restore request', async () => {
    await expect(
      pipelineCheckpointRestoreOp({ worktreePath: '/repo', head: 'not-hex', snapshot: HEAD_LIKE })
    ).rejects.toThrow(/head/)
    expect(execFile).not.toHaveBeenCalled()
  })
})

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
}

function commitAll(dir: string, message: string): void {
  git(['add', '-A'], dir)
  git(['commit', '-qm', message], dir)
}

describe('pipelineCheckpointCaptureOp / pipelineCheckpointRestoreOp against a real repo', () => {
  let root: string
  let repo: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-relay-pipeline-checkpoint-'))
    repo = join(root, 'repo')
    initRepo(repo)
    writeFileSync(join(repo, 'tracked.txt'), 'original\n')
    commitAll(repo, 'init')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('captures without mutating worktree, index, or HEAD, and writes the checkpoint ref', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'modified\n')
    writeFileSync(join(repo, 'new-untracked.txt'), 'scratch\n')

    const headBefore = git(['rev-parse', 'HEAD'], repo)
    const statusBefore = git(['status', '--porcelain', '--untracked-files=all'], repo)

    const result = await pipelineCheckpointCaptureOp({
      worktreePath: repo,
      runId: 'run_abc',
      nodeId: 'node-1',
      attempt: 1
    })

    expect(result.ref).toBe('refs/orca/pipeline/run_abc/node-1-1')
    expect(result.head).toBe(headBefore.trim())
    expect(result.snapshot).not.toBe(result.head)

    expect(git(['rev-parse', 'HEAD'], repo)).toBe(headBefore)
    expect(git(['status', '--porcelain', '--untracked-files=all'], repo)).toBe(statusBefore)

    const refValue = git(['rev-parse', result.ref], repo).trim()
    expect(refValue).toBe(result.snapshot)

    const treeListing = git(['ls-tree', '-r', '--name-only', result.snapshot], repo)
    expect(treeListing.split('\n')).toContain('new-untracked.txt')
  })

  it('captures a clean worktree as HEAD itself, still writing a ref', async () => {
    const head = git(['rev-parse', 'HEAD'], repo).trim()

    const result = await pipelineCheckpointCaptureOp({
      worktreePath: repo,
      runId: 'run_abc',
      nodeId: 'node-1',
      attempt: 2
    })

    expect(result.head).toBe(head)
    expect(result.snapshot).toBe(head)
    expect(git(['rev-parse', result.ref], repo).trim()).toBe(head)
  })

  it('restores the four L9b observables', async () => {
    const { head, snapshot } = await pipelineCheckpointCaptureOp({
      worktreePath: repo,
      runId: 'run_abc',
      nodeId: 'node-1',
      attempt: 1
    })

    writeFileSync(join(repo, 'tracked.txt'), 'clobbered by the attempt\n')
    writeFileSync(join(repo, 'stray.txt'), 'left behind\n')
    git(['add', '-A'], repo)

    const result = await pipelineCheckpointRestoreOp({ worktreePath: repo, head, snapshot })

    expect(result).toEqual({ restored: true })
    expect(git(['rev-parse', 'HEAD'], repo).trim()).toBe(head)
    expect(existsSync(join(repo, 'stray.txt'))).toBe(false)
    expect(git(['status', '--porcelain', '--untracked-files=all'], repo).trim()).toBe('')
  })
})
