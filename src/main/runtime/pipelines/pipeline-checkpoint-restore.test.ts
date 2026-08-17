import { execFileSync } from 'node:child_process'
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLocalCheckpointBackend } from './pipeline-checkpoint'

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

describe('createLocalCheckpointBackend restore', () => {
  let root: string
  let repo: string
  const backend = createLocalCheckpointBackend({})

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-pipeline-checkpoint-restore-'))
    repo = join(root, 'repo')
    initRepo(repo)
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

  it('removes a plain untracked junk file that was never staged or committed', async () => {
    const { head, snapshot } = await backend.capture({
      worktreePath: repo,
      runId: 'run1',
      nodeId: 'node1',
      attempt: 1
    })

    writeFileSync(join(repo, 'junk-untracked.txt'), 'never staged, never committed\n')

    await backend.restore({ worktreePath: repo, head, snapshot })

    expect(existsSync(join(repo, 'junk-untracked.txt'))).toBe(false)
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
    rmSync(join(repo, 'to-be-deleted.txt'))

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

  it('removes an untracked nested git repository left behind by a failed attempt', async () => {
    const { head, snapshot } = await backend.capture({
      worktreePath: repo,
      runId: 'run1',
      nodeId: 'node1',
      attempt: 1
    })

    const residue = join(repo, 'residue')
    mkdirSync(residue, { recursive: true })
    git(['init', '-q'], residue)
    writeFileSync(join(residue, 'junk.txt'), 'nested repo junk\n')

    await backend.restore({ worktreePath: repo, head, snapshot })

    expect(existsSync(residue)).toBe(false)
  })

  it('does not hard-reset a submodule working tree even when submodule.recurse is enabled', async () => {
    const submoduleUpstream = join(root, 'submodule-upstream')
    initRepo(submoduleUpstream)
    writeFileSync(join(submoduleUpstream, 'inner.txt'), 'inner\n')
    git(['add', '-A'], submoduleUpstream)
    git(['commit', '-qm', 'submodule init'], submoduleUpstream)

    git(['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleUpstream, 'sub'], repo)
    git(['add', '-A'], repo)
    git(['commit', '-qm', 'add submodule'], repo)
    git(['config', 'submodule.recurse', 'true'], repo)

    const { head, snapshot } = await backend.capture({
      worktreePath: repo,
      runId: 'run1',
      nodeId: 'node1',
      attempt: 1
    })

    writeFileSync(join(repo, 'sub', 'inner.txt'), 'modified inside submodule by the user\n')

    await backend.restore({ worktreePath: repo, head, snapshot })

    expect(readFileSync(join(repo, 'sub', 'inner.txt'), 'utf8')).toBe(
      'modified inside submodule by the user\n'
    )
  })

  it('restores when the snapshot replaces a tracked file with a directory at the same path', async () => {
    writeFileSync(join(repo, 'config'), 'file content\n')
    git(['add', '-A'], repo)
    git(['commit', '-qm', 'add config file'], repo)

    rmSync(join(repo, 'config'))
    mkdirSync(join(repo, 'config'))
    writeFileSync(join(repo, 'config', 'part'), 'directory content\n')

    const { head, snapshot } = await backend.capture({
      worktreePath: repo,
      runId: 'run1',
      nodeId: 'node1',
      attempt: 1
    })
    expect(snapshot).not.toBe(head)

    await backend.restore({ worktreePath: repo, head, snapshot })

    expect(readFileSync(join(repo, 'config', 'part'), 'utf8')).toBe('directory content\n')
  })

  it('restores when the snapshot replaces a tracked directory with a file at the same path', async () => {
    mkdirSync(join(repo, 'config'))
    writeFileSync(join(repo, 'config', 'part'), 'original directory content\n')
    git(['add', '-A'], repo)
    git(['commit', '-qm', 'add config directory'], repo)

    rmSync(join(repo, 'config'), { recursive: true, force: true })
    writeFileSync(join(repo, 'config'), 'file content\n')

    const { head, snapshot } = await backend.capture({
      worktreePath: repo,
      runId: 'run1',
      nodeId: 'node1',
      attempt: 1
    })
    expect(snapshot).not.toBe(head)

    await backend.restore({ worktreePath: repo, head, snapshot })

    expect(readFileSync(join(repo, 'config'), 'utf8')).toBe('file content\n')
  })

  it('overwrites an ignored directory occupying a path the snapshot tree claims', async () => {
    writeFileSync(join(repo, 'built'), 'tracked content\n')

    const { head, snapshot } = await backend.capture({
      worktreePath: repo,
      runId: 'run1',
      nodeId: 'node1',
      attempt: 1
    })
    expect(snapshot).not.toBe(head)

    rmSync(join(repo, 'built'))
    // .git/info/exclude (not .gitignore) so the rule survives restore's own reset --hard.
    appendFileSync(join(repo, '.git', 'info', 'exclude'), 'built\n')
    mkdirSync(join(repo, 'built'))
    writeFileSync(join(repo, 'built', 'junk.txt'), 'ignored directory junk\n')

    await backend.restore({ worktreePath: repo, head, snapshot })

    expect(readFileSync(join(repo, 'built'), 'utf8')).toBe('tracked content\n')
  })
})
