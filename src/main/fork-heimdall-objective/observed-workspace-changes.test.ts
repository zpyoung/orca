import { chmod, mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import type { FileStat, IFilesystemProvider } from '../providers/types'
import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import { observeObjectiveWorkspaceManifest } from './objective-workspace-manifest'
import {
  captureObjectiveWorkspaceBaseline,
  validateObjectiveWorkspaceChanges
} from './observed-workspace-changes'

const temporaryDirectories: string[] = []
const SSH_TARGET = 'objective-observation-test'

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function folderTarget(workspacePath: string): ObjectiveWorkspaceTarget {
  return { kind: 'folder', executionHostId: 'local', workspacePath, fileProvider: null }
}

function gitTarget(workspacePath: string): ObjectiveWorkspaceTarget {
  const runtimeTarget = {
    executionHostId: 'local',
    worktree: {
      id: `objective-repo::${workspacePath}`,
      repoId: 'objective-repo',
      path: workspacePath,
      git: { path: workspacePath, branch: 'main', isBare: false, isMainWorktree: true }
    } as unknown as RuntimeGitTarget['worktree']
  } satisfies RuntimeGitTarget
  return {
    kind: 'git',
    executionHostId: 'local',
    workspacePath,
    fileProvider: null,
    gitTarget: runtimeTarget
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  await gitExecFileAsync(args, { cwd, admissionTier: 'background' })
}

async function commitAll(root: string, message: string): Promise<void> {
  await git(root, ['add', '-A'])
  await git(root, [
    '-c',
    'user.name=Objective Test',
    '-c',
    'user.email=objective@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    message
  ])
}

async function gitRepository(prefix: string): Promise<string> {
  const root = await temporaryDirectory(prefix)
  await git(root, ['init'])
  await mkdir(join(root, 'src'))
  return root
}

type MemoryNode =
  | { type: 'directory'; mtime: number }
  | { type: 'file'; content: string; mtime: number }

class MemoryFilesystemProvider {
  private readonly nodes = new Map<string, MemoryNode>([
    ['/srv/objective', { type: 'directory', mtime: 1 }]
  ])
  readonly observedPaths: string[] = []
  private clock = 1

  put(path: string, content: string): void {
    this.createParents(dirname(path))
    this.nodes.set(path, { type: 'file', content, mtime: ++this.clock })
  }

  async readDir(dirPath: string) {
    this.observedPaths.push(dirPath)
    const prefix = `${dirPath.replace(/\/$/u, '')}/`
    const entries = new Map<string, MemoryNode>()
    for (const [path, node] of this.nodes) {
      if (!path.startsWith(prefix)) {
        continue
      }
      const suffix = path.slice(prefix.length)
      if (!suffix || suffix.includes('/')) {
        continue
      }
      entries.set(suffix, node)
    }
    return [...entries].map(([name, node]) => ({
      name,
      isDirectory: node.type === 'directory',
      isSymlink: false
    }))
  }

  async readFile(path: string) {
    this.observedPaths.push(path)
    const node = this.nodes.get(path)
    if (!node || node.type !== 'file') {
      throw this.missing()
    }
    return { content: node.content, isBinary: false }
  }

  async lstat(path: string): Promise<FileStat> {
    this.observedPaths.push(path)
    const node = this.nodes.get(path)
    if (!node) {
      throw this.missing()
    }
    return {
      type: node.type,
      size: node.type === 'file' ? Buffer.byteLength(node.content) : 0,
      mtime: node.mtime,
      mtimeMs: node.mtime
    }
  }

  stat(path: string): Promise<FileStat> {
    return this.lstat(path)
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.observedPaths.push(path)
    this.put(path, content)
  }

  async createDir(path: string): Promise<void> {
    this.observedPaths.push(path)
    this.createParents(path)
  }

  async renameNoClobber(oldPath: string, newPath: string): Promise<void> {
    this.observedPaths.push(oldPath, newPath)
    if (this.nodes.has(newPath)) {
      throw Object.assign(new Error('destination exists'), { code: 'EEXIST' })
    }
    const node = this.nodes.get(oldPath)
    if (!node) {
      throw this.missing()
    }
    this.createParents(dirname(newPath))
    this.nodes.set(newPath, node)
    this.nodes.delete(oldPath)
  }

  async deletePath(path: string): Promise<void> {
    this.observedPaths.push(path)
    this.nodes.delete(path)
  }

  private createParents(path: string): void {
    if (path === '/' || this.nodes.has(path)) {
      return
    }
    this.createParents(posix.dirname(path))
    this.nodes.set(path, { type: 'directory', mtime: ++this.clock })
  }

  private missing(): Error {
    return Object.assign(new Error('missing'), { code: 'ENOENT' })
  }
}

afterEach(async () => {
  unregisterSshFilesystemProvider(SSH_TARGET)
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('objective observed workspace changes', () => {
  it('does not blame preexisting Git dirt and accepts the reported in-territory change', async () => {
    const root = await temporaryDirectory('orca-objective-observed-git-')
    await git(root, ['init'])
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'preexisting.ts'), 'clean\n')
    await writeFile(join(root, 'src', 'changed.ts'), 'before\n')
    await git(root, ['add', 'src'])
    await git(root, [
      '-c',
      'user.name=Objective Test',
      '-c',
      'user.email=objective@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'initial'
    ])
    await writeFile(join(root, 'src', 'preexisting.ts'), 'dirty before dispatch\n')
    const target = gitTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'git-attempt')

    await writeFile(join(root, 'src', 'changed.ts'), 'after\n')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'git-attempt',
        reportedFiles: ['src/changed.ts'],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({ ok: true, changedPaths: ['src/changed.ts'] })
  })

  it.skipIf(process.platform === 'win32')(
    'reports a Git executable-mode-only change even when file content is unchanged',
    async () => {
      const root = await temporaryDirectory('orca-objective-observed-mode-')
      await git(root, ['init'])
      await mkdir(join(root, 'src'))
      const script = join(root, 'src', 'script.sh')
      await writeFile(script, '#!/bin/sh\nexit 0\n')
      await chmod(script, 0o644)
      await git(root, ['add', 'src/script.sh'])
      await git(root, [
        '-c',
        'user.name=Objective Test',
        '-c',
        'user.email=objective@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'initial'
      ])
      const target = gitTarget(root)
      await captureObjectiveWorkspaceBaseline(target, 'mode-attempt')

      await chmod(script, 0o755)

      await expect(
        validateObjectiveWorkspaceChanges({
          target,
          attemptFingerprint: 'mode-attempt',
          reportedFiles: ['src/script.sh'],
          writeTerritory: ['src/**']
        })
      ).resolves.toEqual({ ok: true, changedPaths: ['src/script.sh'] })

      const untracked = join(root, 'src', 'untracked.sh')
      await writeFile(untracked, '#!/bin/sh\nexit 0\n')
      await chmod(untracked, 0o644)
      await captureObjectiveWorkspaceBaseline(target, 'untracked-mode-attempt')
      await chmod(untracked, 0o755)

      await expect(
        validateObjectiveWorkspaceChanges({
          target,
          attemptFingerprint: 'untracked-mode-attempt',
          reportedFiles: ['src/untracked.sh'],
          writeTerritory: ['src/**']
        })
      ).resolves.toEqual({ ok: true, changedPaths: ['src/untracked.sh'] })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reports a tracked file-to-symlink type change even when the Git object content is unchanged',
    async () => {
      const root = await temporaryDirectory('orca-objective-observed-type-')
      await git(root, ['init'])
      await mkdir(join(root, 'src'))
      const changedPath = join(root, 'src', 'linkish')
      await writeFile(changedPath, 'target.txt')
      await writeFile(join(root, 'src', 'target.txt'), 'target contents')
      await git(root, ['add', 'src'])
      await git(root, [
        '-c',
        'user.name=Objective Test',
        '-c',
        'user.email=objective@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'initial'
      ])
      const target = gitTarget(root)
      await captureObjectiveWorkspaceBaseline(target, 'type-attempt')

      await unlink(changedPath)
      await symlink('target.txt', changedPath)

      await expect(
        validateObjectiveWorkspaceChanges({
          target,
          attemptFingerprint: 'type-attempt',
          reportedFiles: ['src/linkish'],
          writeTerritory: ['src/**']
        })
      ).resolves.toEqual({ ok: true, changedPaths: ['src/linkish'] })
    }
  )

  it('fingerprints a dirty submodule from superproject metadata without hashing its directory', async () => {
    const child = await temporaryDirectory('orca-objective-observed-submodule-child-')
    await git(child, ['init'])
    await writeFile(join(child, 'child.txt'), 'before\n')
    await git(child, ['add', 'child.txt'])
    await git(child, [
      '-c',
      'user.name=Objective Test',
      '-c',
      'user.email=objective@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'child'
    ])
    const root = await temporaryDirectory('orca-objective-observed-submodule-parent-')
    await git(root, ['init'])
    await git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'vendor/child'])
    await git(root, ['add', '.'])
    await git(root, [
      '-c',
      'user.name=Objective Test',
      '-c',
      'user.email=objective@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'parent'
    ])
    const target = gitTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'submodule-attempt')

    await writeFile(join(root, 'vendor', 'child', 'child.txt'), 'after\n')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'submodule-attempt',
        reportedFiles: ['vendor/child'],
        writeTerritory: ['vendor/**']
      })
    ).resolves.toEqual({ ok: true, changedPaths: ['vendor/child'] })
  })

  it('detects both additions and deletions in a folder workspace', async () => {
    const root = await temporaryDirectory('orca-objective-observed-folder-')
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'deleted.ts'), 'delete me\n')
    const target = folderTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'folder-attempt')

    await unlink(join(root, 'src', 'deleted.ts'))
    await writeFile(join(root, 'src', 'added.ts'), 'added\n')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'folder-attempt',
        reportedFiles: ['src/added.ts', 'src/deleted.ts'],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({ ok: true, changedPaths: ['src/added.ts', 'src/deleted.ts'] })
  })

  it('rejects a host-observed change outside write territory', async () => {
    const root = await temporaryDirectory('orca-objective-observed-territory-')
    await mkdir(join(root, 'docs'))
    const target = folderTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'outside-attempt')
    await writeFile(join(root, 'docs', 'escape.md'), 'outside\n')

    const result = await validateObjectiveWorkspaceChanges({
      target,
      attemptFingerprint: 'outside-attempt',
      reportedFiles: [],
      writeTerritory: ['src/**']
    })

    expect(result).toEqual({
      ok: false,
      reason: 'observed-change-outside-write-territory:docs/escape.md'
    })
  })

  it('rejects an in-territory host change omitted from reported files', async () => {
    const root = await temporaryDirectory('orca-objective-observed-unreported-')
    await mkdir(join(root, 'src'))
    const target = folderTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'unreported-attempt')
    await writeFile(join(root, 'src', 'hidden.ts'), 'hidden\n')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'unreported-attempt',
        reportedFiles: [],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({
      ok: false,
      reason: 'reported-files-do-not-match-observed-changes'
    })
  })

  it('fails closed when the originating baseline is missing', async () => {
    const root = await temporaryDirectory('orca-objective-observed-missing-')
    await expect(
      validateObjectiveWorkspaceChanges({
        target: folderTarget(root),
        attemptFingerprint: 'never-captured',
        reportedFiles: [],
        writeTerritory: ['**']
      })
    ).resolves.toEqual({ ok: false, reason: 'objective-workspace-baseline-missing' })
  })

  it('fails closed when the stored baseline is malformed', async () => {
    const root = await temporaryDirectory('orca-objective-observed-malformed-')
    const target = folderTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'malformed-attempt')
    const baselineDirectory = join(
      root,
      '.orca',
      'heimdall',
      'objective',
      'reports',
      'workspace-baselines'
    )
    const [baselineFile] = await readdir(baselineDirectory)
    await writeFile(join(baselineDirectory, baselineFile!), '{"version":1}')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'malformed-attempt',
        reportedFiles: [],
        writeTerritory: ['**']
      })
    ).resolves.toEqual({ ok: false, reason: 'objective-workspace-baseline-malformed' })
  })

  it('reads and stores an SSH folder baseline only through its execution-host provider', async () => {
    const provider = new MemoryFilesystemProvider()

    provider.put('/srv/objective/src/remote.ts', 'before\n')
    registerSshFilesystemProvider(SSH_TARGET, provider as unknown as IFilesystemProvider)
    const target: ObjectiveWorkspaceTarget = {
      kind: 'folder',
      executionHostId: `ssh:${SSH_TARGET}`,
      workspacePath: '/srv/objective',
      fileProvider: provider as unknown as IFilesystemProvider
    }
    await captureObjectiveWorkspaceBaseline(target, 'ssh-attempt')
    provider.put('/srv/objective/src/remote.ts', 'after\n')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'ssh-attempt',
        reportedFiles: ['src/remote.ts'],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({ ok: true, changedPaths: ['src/remote.ts'] })
    expect(provider.observedPaths.length).toBeGreaterThan(0)
    expect(provider.observedPaths.every((path) => path.startsWith('/srv/objective'))).toBe(true)
    expect(provider.observedPaths.some((path) => path.includes('/workspace-baselines/'))).toBe(true)
  })

  it('fails closed when an SSH route is rebound after baseline capture', async () => {
    const originalProvider = new MemoryFilesystemProvider()
    originalProvider.put('/srv/objective/src/remote.ts', 'before\n')
    registerSshFilesystemProvider(SSH_TARGET, originalProvider as unknown as IFilesystemProvider)
    const target: ObjectiveWorkspaceTarget = {
      kind: 'folder',
      executionHostId: `ssh:${SSH_TARGET}`,
      workspacePath: '/srv/objective',
      fileProvider: originalProvider as unknown as IFilesystemProvider
    }
    await captureObjectiveWorkspaceBaseline(target, 'rebound-attempt')
    const replacementProvider = new MemoryFilesystemProvider()
    registerSshFilesystemProvider(SSH_TARGET, replacementProvider as unknown as IFilesystemProvider)

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'rebound-attempt',
        reportedFiles: [],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({ ok: false, reason: 'objective-workspace-route-unavailable' })
    expect(replacementProvider.observedPaths).toEqual([])
  })
  it('does not report a path that was dirty at capture and is then committed unchanged', async () => {
    const root = await gitRepository('orca-objective-observed-commit-')
    await writeFile(join(root, 'src', 'staged.ts'), 'before\n')
    await commitAll(root, 'initial')
    await writeFile(join(root, 'src', 'staged.ts'), 'worker edit\n')
    const target = gitTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'commit-attempt')

    await commitAll(root, 'worker commit')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'commit-attempt',
        reportedFiles: [],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({ ok: true, changedPaths: [] })
  })

  it('reports a path that was dirty at capture and is then restored to HEAD', async () => {
    const root = await gitRepository('orca-objective-observed-revert-')
    await writeFile(join(root, 'src', 'reverted.ts'), 'committed\n')
    await commitAll(root, 'initial')
    await writeFile(join(root, 'src', 'reverted.ts'), 'dirty at capture\n')
    const target = gitTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'revert-attempt')

    await git(root, ['checkout', '--', 'src/reverted.ts'])

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'revert-attempt',
        reportedFiles: ['src/reverted.ts'],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({ ok: true, changedPaths: ['src/reverted.ts'] })
  })

  it('reports a file created and committed without being dirty at either observation', async () => {
    const root = await gitRepository('orca-objective-observed-added-')
    await writeFile(join(root, 'src', 'existing.ts'), 'existing\n')
    await commitAll(root, 'initial')
    const target = gitTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'added-attempt')

    await writeFile(join(root, 'src', 'added.ts'), 'added\n')
    await commitAll(root, 'worker commit')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'added-attempt',
        reportedFiles: ['src/added.ts'],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({ ok: true, changedPaths: ['src/added.ts'] })
  })

  it.skipIf(process.platform === 'win32')(
    'observes a dirty symlink that points at a missing file instead of failing on it',
    async () => {
      const root = await gitRepository('orca-objective-observed-broken-link-')
      await writeFile(join(root, 'src', 'kept.ts'), 'kept\n')
      await commitAll(root, 'initial')
      await symlink('does-not-exist.ts', join(root, 'src', 'dangling.ts'))
      const target = gitTarget(root)
      await captureObjectiveWorkspaceBaseline(target, 'broken-link-attempt')

      await writeFile(join(root, 'src', 'kept.ts'), 'changed\n')

      await expect(
        validateObjectiveWorkspaceChanges({
          target,
          attemptFingerprint: 'broken-link-attempt',
          reportedFiles: ['src/kept.ts'],
          writeTerritory: ['src/**']
        })
      ).resolves.toEqual({ ok: true, changedPaths: ['src/kept.ts'] })
    }
  )

  it.skipIf(process.platform === 'win32')(
    'reports a retargeted symlink whose old and new targets hold identical content',
    async () => {
      const root = await gitRepository('orca-objective-observed-retarget-')
      await writeFile(join(root, 'src', 'first.ts'), 'same\n')
      await writeFile(join(root, 'src', 'second.ts'), 'same\n')
      await symlink('first.ts', join(root, 'src', 'link.ts'))
      await commitAll(root, 'initial')
      const target = gitTarget(root)
      await captureObjectiveWorkspaceBaseline(target, 'retarget-attempt')

      await unlink(join(root, 'src', 'link.ts'))
      await symlink('second.ts', join(root, 'src', 'link.ts'))

      await expect(
        validateObjectiveWorkspaceChanges({
          target,
          attemptFingerprint: 'retarget-attempt',
          reportedFiles: ['src/link.ts'],
          writeTerritory: ['src/**']
        })
      ).resolves.toEqual({ ok: true, changedPaths: ['src/link.ts'] })
    }
  )

  it('validates a baseline captured in the legacy whole-manifest format', async () => {
    const root = await gitRepository('orca-objective-observed-legacy-')
    await writeFile(join(root, 'src', 'legacy.ts'), 'before\n')
    await commitAll(root, 'initial')
    const target = gitTarget(root)
    await captureObjectiveWorkspaceBaseline(target, 'legacy-attempt')

    const baselineDirectory = join(
      root,
      '.git',
      'orca-heimdall',
      'objective',
      'reports',
      'workspace-baselines'
    )
    const [baselineName] = await readdir(baselineDirectory)
    await writeFile(
      join(baselineDirectory, baselineName!),
      JSON.stringify({
        version: 1,
        attemptFingerprint: 'legacy-attempt',
        target: {
          kind: 'git',
          executionHostId: 'local',
          workspacePath: root,
          gitWorktreeId: `objective-repo::${root}`
        },
        entries: await observeObjectiveWorkspaceManifest(target)
      })
    )

    await writeFile(join(root, 'src', 'legacy.ts'), 'after\n')

    await expect(
      validateObjectiveWorkspaceChanges({
        target,
        attemptFingerprint: 'legacy-attempt',
        reportedFiles: ['src/legacy.ts'],
        writeTerritory: ['src/**']
      })
    ).resolves.toEqual({ ok: true, changedPaths: ['src/legacy.ts'] })
  })
})
