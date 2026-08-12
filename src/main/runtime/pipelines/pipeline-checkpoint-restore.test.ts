import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLocalCheckpointBackend } from './pipeline-checkpoint'

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

describe('createLocalCheckpointBackend restore', () => {
  let root: string
  let repo: string
  const backend = createLocalCheckpointBackend({})

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-pipeline-checkpoint-restore-'))
    repo = join(root, 'repo')
    mkdirSync(repo, { recursive: true })
    git(['init', '-q', '-b', 'main'], repo)
    git(['config', 'user.email', 'test@example.com'], repo)
    git(['config', 'user.name', 'Test'], repo)
    writeFileSync(join(repo, 'tracked.txt'), 'original\n')
    writeFileSync(join(repo, 'to-be-deleted.txt'), 'will vanish before checkpoint\n')
    writeFileSync(join(repo, '.gitignore'), 'ignored.log\n')
    git(['add', '-A'], repo)
    git(['commit', '-qm', 'init'], repo)
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('resets branch HEAD, discarding the failed attempt commit', async () => {
    const { head, snapshot } = await backend.capture({
      worktreePath: repo,
      runId: 'run1',
      nodeId: 'node1',
      attempt: 1
    })

    writeFileSync(join(repo, 'junk.txt'), 'junk commit content\n')
    git(['add', '-A'], repo)
    git(['commit', '-qm', 'junk commit'], repo)

    await backend.restore({ worktreePath: repo, head, snapshot })

    expect(git(['rev-parse', 'HEAD'], repo).trim()).toBe(head)
    expect(existsSync(join(repo, 'junk.txt'))).toBe(false)
  })

  it('flattens a staged modification to unstaged and preserves untracked classification', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'staged change\n')
    git(['add', 'tracked.txt'], repo)
    writeFileSync(join(repo, 'repro.txt'), 'untracked at checkpoint\n')

    const { head, snapshot } = await backend.capture({
      worktreePath: repo,
      runId: 'run1',
      nodeId: 'node1',
      attempt: 1
    })

    writeFileSync(join(repo, 'junk-untracked.txt'), 'junk\n')
    git(['add', '-A'], repo)
    git(['commit', '-qm', 'attempt failure'], repo)

    await backend.restore({ worktreePath: repo, head, snapshot })

    const status = git(['status', '--porcelain', '--untracked-files=all'], repo)
    const lines = new Set(status.split('\n').filter(Boolean))
    expect(lines).toContain(' M tracked.txt')
    expect(lines).toContain('?? repro.txt')
    expect(readFileSync(join(repo, 'tracked.txt'), 'utf8')).toBe('staged change\n')
    expect(readFileSync(join(repo, 'repro.txt'), 'utf8')).toBe('untracked at checkpoint\n')
    expect(existsSync(join(repo, 'junk-untracked.txt'))).toBe(false)

    const indexTree = git(['write-tree'], repo).trim()
    const headTree = git(['rev-parse', `${head}^{tree}`], repo).trim()
    expect(indexTree).toBe(headTree)
  })

  it('removes an on-disk file that head tracked but the snapshot no longer contains', async () => {
    expect(existsSync(join(repo, 'to-be-deleted.txt'))).toBe(true)
    execFileSync('rm', [join(repo, 'to-be-deleted.txt')])

    const { head, snapshot } = await backend.capture({
      worktreePath: repo,
      runId: 'run1',
      nodeId: 'node1',
      attempt: 1
    })
    expect(snapshot).not.toBe(head)

    writeFileSync(join(repo, 'to-be-deleted.txt'), 'resurrected by a failed attempt\n')
    git(['add', '-A'], repo)
    git(['commit', '-qm', 'oops'], repo)

    await backend.restore({ worktreePath: repo, head, snapshot })

    expect(existsSync(join(repo, 'to-be-deleted.txt'))).toBe(false)
  })

  it('leaves an ignored file untouched unless the snapshot claims its path', async () => {
    const { head, snapshot } = await backend.capture({
      worktreePath: repo,
      runId: 'run1',
      nodeId: 'node1',
      attempt: 1
    })
    writeFileSync(join(repo, 'ignored.log'), 'pre-existing ignored content\n')

    await backend.restore({ worktreePath: repo, head, snapshot })

    expect(readFileSync(join(repo, 'ignored.log'), 'utf8')).toBe('pre-existing ignored content\n')
  })

  it('overwrites a tracked ignored-file path when the snapshot tree contains a newer version', async () => {
    // force-tracked despite matching .gitignore — a file can be both (e.g. tracked before the
    // ignore rule was added); add -A still picks up modifications to it regardless of ignore status
    writeFileSync(join(repo, 'ignored.log'), 'original\n')
    git(['add', '-f', 'ignored.log'], repo)
    git(['commit', '-qm', 'track ignored.log despite gitignore'], repo)

    writeFileSync(join(repo, 'ignored.log'), 'captured content\n')
    const { head, snapshot } = await backend.capture({
      worktreePath: repo,
      runId: 'run1',
      nodeId: 'node1',
      attempt: 1
    })
    expect(snapshot).not.toBe(head)

    writeFileSync(join(repo, 'ignored.log'), 'clobbered by a failed attempt\n')

    await backend.restore({ worktreePath: repo, head, snapshot })

    expect(readFileSync(join(repo, 'ignored.log'), 'utf8')).toBe('captured content\n')
  })
})
