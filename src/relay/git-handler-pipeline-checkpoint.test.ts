import { execFile, execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as childProcess from 'node:child_process'
import type * as relayCommandEnv from './relay-command-env'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  const mockedExecFile = vi.fn(actual.execFile)
  // why: promisify(execFile) resolves through this symbol, bypassing the vi.fn wrapper (and its
  // call recording) entirely unless the replacement routes back through the mock itself
  const promisifyCustomKey = Symbol.for('nodejs.util.promisify.custom')
  Object.defineProperty(mockedExecFile, promisifyCustomKey, {
    value: (
      file: string,
      args: string[],
      options: childProcess.ExecFileOptions
    ): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> =>
      new Promise((resolve, reject) => {
        mockedExecFile(file, args, options, (error, stdout, stderr) => {
          if (error) {
            reject(Object.assign(error, { stdout, stderr }))
            return
          }
          resolve({ stdout, stderr })
        })
      })
  })
  return { ...actual, execFile: mockedExecFile }
})

const RELAY_ENV_MARKER = 'ORCA_TEST_RELAY_ENV_MARKER'

vi.mock('./relay-command-env', async (importOriginal) => {
  const actual = await importOriginal<typeof relayCommandEnv>()
  return {
    ...actual,
    buildRelayGitEnv: (
      ...args: Parameters<typeof actual.buildRelayGitEnv>
    ): NodeJS.ProcessEnv => ({
      ...actual.buildRelayGitEnv(...args),
      [RELAY_ENV_MARKER]: 'present'
    })
  }
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

// `git init -b` post-dates the Git 2.25 baseline; set the branch name before the first
// commit instead, which every Git version supports.
function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(['init', '-q'], dir)
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], dir)
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

  it('restores branch HEAD, index, worktree content, and ignored-file handling from a dirty capture', async () => {
    writeFileSync(join(repo, '.gitignore'), 'ignored.log\n')
    git(['add', '-A'], repo)
    git(['commit', '-qm', 'commit gitignore'], repo)

    // a staged modification to a tracked file, which restore must flatten to unstaged
    writeFileSync(join(repo, 'tracked.txt'), 'staged change\n')
    git(['add', 'tracked.txt'], repo)
    // an untracked file present at checkpoint time, which restore must keep untracked
    writeFileSync(join(repo, 'repro.txt'), 'untracked at checkpoint\n')
    // untracked and not ignored, so the temp-index `add -A` captures it into the snapshot tree
    writeFileSync(join(repo, 'built'), 'captured by the checkpoint\n')

    const { head, snapshot } = await pipelineCheckpointCaptureOp({
      worktreePath: repo,
      runId: 'run_abc',
      nodeId: 'node-1',
      attempt: 1
    })
    expect(snapshot).not.toBe(head)

    // the failed attempt clobbers tracked/untracked content and leaves stray residue;
    // 'built' is deliberately left out of this commit (see below)
    writeFileSync(join(repo, 'tracked.txt'), 'clobbered by the attempt\n')
    writeFileSync(join(repo, 'repro.txt'), 'clobbered by the attempt\n')
    writeFileSync(join(repo, 'stray.txt'), 'left behind\n')
    git(['add', 'tracked.txt', 'repro.txt', 'stray.txt'], repo)
    git(['commit', '-qm', 'attempt failure'], repo)

    // an ignored file the snapshot never claimed, which restore must leave alone
    writeFileSync(join(repo, 'ignored.log'), 'pre-existing ignored content\n')
    // local-only exclude (not .gitignore) so the rule survives restore's own reset --hard;
    // 'built' was never committed, so an ignored directory can now obstruct its path
    rmSync(join(repo, 'built'))
    appendFileSync(join(repo, '.git', 'info', 'exclude'), 'built\n')
    mkdirSync(join(repo, 'built'))
    writeFileSync(join(repo, 'built', 'junk.txt'), 'ignored directory junk\n')

    const result = await pipelineCheckpointRestoreOp({ worktreePath: repo, head, snapshot })
    expect(result).toEqual({ restored: true })

    // (1) branch HEAD
    expect(git(['rev-parse', 'HEAD'], repo).trim()).toBe(head)

    // (2) index = recorded head's tree: staged mod comes back unstaged, untracked stays untracked
    const status = git(['status', '--porcelain', '--untracked-files=all'], repo)
    const lines = new Set(status.split('\n').filter(Boolean))
    expect(lines).toContain(' M tracked.txt')
    expect(lines).toContain('?? repro.txt')
    const indexTree = git(['write-tree'], repo).trim()
    const headTree = git(['rev-parse', `${head}^{tree}`], repo).trim()
    expect(indexTree).toBe(headTree)

    // (3) worktree content = snapshot tree; residue absent from the snapshot is removed
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('staged change\n')
    expect(readFileSync(join(repo, 'repro.txt'), 'utf8')).toBe('untracked at checkpoint\n')
    expect(existsSync(join(repo, 'stray.txt'))).toBe(false)

    // (4) ignored files untouched, except where the snapshot claims the path
    expect(readFileSync(join(repo, 'ignored.log'), 'utf8')).toBe('pre-existing ignored content\n')
    expect(readFileSync(join(repo, 'built'), 'utf8')).toBe('captured by the checkpoint\n')
  })

  it('layers GIT_INDEX_FILE on top of the relay git environment, not raw process.env', async () => {
    vi.mocked(execFile).mockClear()
    writeFileSync(join(repo, 'tracked.txt'), 'modified\n')

    await pipelineCheckpointCaptureOp({
      worktreePath: repo,
      runId: 'run_abc',
      nodeId: 'node-1',
      attempt: 1
    })

    const gitCalls = vi
      .mocked(execFile)
      .mock.calls.filter((call) => call[0] === 'git') as unknown as [
      string,
      string[],
      { env?: NodeJS.ProcessEnv }
    ][]
    const readTreeCall = gitCalls.find((call) => call[1][0] === 'read-tree')
    expect(readTreeCall?.[2].env?.GIT_INDEX_FILE).toBeDefined()
    expect(readTreeCall?.[2].env?.[RELAY_ENV_MARKER]).toBe('present')
  })
})
