import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLocalCheckpointBackend } from './pipeline-checkpoint'

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

describe('createLocalCheckpointBackend', () => {
  let root: string
  let repo: string
  const backend = createLocalCheckpointBackend({})

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-pipeline-checkpoint-'))
    repo = join(root, 'repo')
    initRepo(repo)
    writeFileSync(join(repo, 'tracked.txt'), 'original\n')
    commitAll(repo, 'init')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('does not mutate worktree, index, or HEAD during capture', async () => {
    writeFileSync(join(repo, 'tracked.txt'), 'modified\n')
    writeFileSync(join(repo, 'new-untracked.txt'), 'scratch\n')
    git(['add', 'tracked.txt'], repo)

    const headBefore = git(['rev-parse', 'HEAD'], repo)
    const before = git(['status', '--porcelain', '--untracked-files=all'], repo)
    await backend.capture({ worktreePath: repo, runId: 'run1', nodeId: 'node1', attempt: 1 })
    const after = git(['status', '--porcelain', '--untracked-files=all'], repo)
    const headAfter = git(['rev-parse', 'HEAD'], repo)

    expect(after).toBe(before)
    expect(headAfter).toBe(headBefore)
  })

  it('captures an untracked file into the snapshot tree', async () => {
    writeFileSync(join(repo, 'untracked.txt'), 'new file\n')

    const { snapshot } = await backend.capture({
      worktreePath: repo,
      runId: 'run1',
      nodeId: 'node1',
      attempt: 1
    })

    const treeListing = git(['ls-tree', '-r', '--name-only', snapshot], repo)
    expect(treeListing.split('\n')).toContain('untracked.txt')
  })

  it('checkpoints a clean worktree as HEAD itself, still creating a ref', async () => {
    const head = git(['rev-parse', 'HEAD'], repo).trim()

    const result = await backend.capture({
      worktreePath: repo,
      runId: 'run1',
      nodeId: 'node1',
      attempt: 1
    })

    expect(result.head).toBe(head)
    expect(result.snapshot).toBe(head)
    const refValue = git(['rev-parse', result.ref], repo).trim()
    expect(refValue).toBe(head)
  })

  it('creates the checkpoint ref outside the branch namespace', async () => {
    writeFileSync(join(repo, 'untracked.txt'), 'new file\n')

    const { ref } = await backend.capture({
      worktreePath: repo,
      runId: 'run7',
      nodeId: 'node7',
      attempt: 2
    })

    expect(ref).toBe('refs/orca/pipeline/run7/node7-2')
    const branches = git(['branch', '--list'], repo)
    expect(branches).not.toContain('node7')
    expect(existsSync(join(repo, '.git', 'refs', 'orca', 'pipeline', 'run7'))).toBe(true)
  })

  it('survives git gc --prune=now and still restores afterward', async () => {
    writeFileSync(join(repo, 'untracked.txt'), 'new file\n')
    const { head, snapshot } = await backend.capture({
      worktreePath: repo,
      runId: 'run1',
      nodeId: 'node1',
      attempt: 1
    })

    git(['gc', '--prune=now'], repo)

    expect(git(['cat-file', '-t', snapshot], repo).trim()).toBe('commit')
    await expect(backend.restore({ worktreePath: repo, head, snapshot })).resolves.toBeUndefined()
    expect(readFileSync(join(repo, 'untracked.txt'), 'utf8')).toBe('new file\n')
  })

  it('captures only the gitlink for a submodule, never its inner content', async () => {
    const submoduleUpstream = join(root, 'submodule-upstream')
    initRepo(submoduleUpstream)
    writeFileSync(join(submoduleUpstream, 'inner.txt'), 'inner\n')
    commitAll(submoduleUpstream, 'submodule init')

    git(
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        submoduleUpstream,
        'sub'
      ],
      repo
    )
    commitAll(repo, 'add submodule')

    writeFileSync(join(repo, 'sub', 'dirty.txt'), 'dirty inside submodule\n')

    const { snapshot } = await backend.capture({
      worktreePath: repo,
      runId: 'run1',
      nodeId: 'node1',
      attempt: 1
    })

    const entry = git(['ls-tree', snapshot, 'sub'], repo)
    expect(entry).toContain('160000 commit')
    const nested = git(['ls-tree', '-r', snapshot], repo)
    expect(nested).not.toContain('dirty.txt')
  })
})
