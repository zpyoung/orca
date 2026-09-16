import { chmod, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { registerSshGitProvider, unregisterSshGitProvider } from '../providers/ssh-git-dispatch'
import type { IFilesystemProvider } from '../providers/types'
import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'
import { computeWorkspaceContentIdentity, type ObjectiveWorkspaceTarget } from './content-identity'
import { computeObjectiveWorktreeContentDigest } from './objective-workspace-manifest'

const temporaryDirectories: string[] = []

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

async function git(cwd: string, args: string[]): Promise<void> {
  await gitExecFileAsync(args, { cwd, admissionTier: 'background' })
}

async function commitAll(cwd: string, message: string): Promise<void> {
  await git(cwd, ['add', '--all'])
  await git(cwd, [
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

function gitTarget(workspacePath: string): ObjectiveWorkspaceTarget {
  const runtimeTarget = {
    executionHostId: 'local',
    worktree: {
      id: 'objective-test',
      repoId: 'objective-test-repo',
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

function folderTarget(workspacePath: string): ObjectiveWorkspaceTarget {
  return {
    kind: 'folder',
    executionHostId: 'local',
    workspacePath,
    fileProvider: null
  }
}

afterEach(async () => {
  unregisterSshFilesystemProvider('objective-content-test')
  unregisterSshGitProvider('objective-content-test')
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('computeWorkspaceContentIdentity', () => {
  it('tracks Git tree, dirty file hashes and deletions while ignoring reports in the git directory', async () => {
    const root = await temporaryDirectory('orca-objective-git-')
    await git(root, ['init'])
    await writeFile(join(root, 'tracked.txt'), 'committed\n')
    await commitAll(root, 'initial')
    const target = gitTarget(root)
    const cleanIdentity = await computeWorkspaceContentIdentity(target)

    await mkdir(join(root, '.git', 'orca-heimdall', 'objective', 'reports'), { recursive: true })
    await writeFile(
      join(root, '.git', 'orca-heimdall', 'objective', 'reports', 'attempt.json'),
      '{"plan":[]}'
    )
    await expect(computeWorkspaceContentIdentity(target)).resolves.toBe(cleanIdentity)

    await writeFile(join(root, 'untracked.txt'), 'one\n')
    const untrackedIdentity = await computeWorkspaceContentIdentity(target)
    expect(untrackedIdentity).not.toBe(cleanIdentity)
    await writeFile(join(root, 'untracked.txt'), 'two\n')
    await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(untrackedIdentity)

    await rm(join(root, 'tracked.txt'))
    await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(untrackedIdentity)
  })

  it.skipIf(process.platform === 'win32')(
    'ignores index-only staging while tracking worktree, HEAD, rename, deletion, and mode changes',
    async () => {
      const root = await temporaryDirectory('orca-objective-git-index-')
      await git(root, ['init'])
      const trackedPath = join(root, 'tracked.txt')
      await writeFile(trackedPath, 'initial\n')
      await commitAll(root, 'initial')
      const target = gitTarget(root)
      const cleanIdentity = await computeWorkspaceContentIdentity(target)

      await writeFile(trackedPath, 'staged content\n')
      const dirtyIdentity = await computeWorkspaceContentIdentity(target)
      expect(dirtyIdentity).not.toBe(cleanIdentity)
      await git(root, ['add', '--', 'tracked.txt'])
      await expect(computeWorkspaceContentIdentity(target)).resolves.toBe(dirtyIdentity)

      await writeFile(trackedPath, 'worktree content\n')
      const worktreeIdentity = await computeWorkspaceContentIdentity(target)
      expect(worktreeIdentity).not.toBe(dirtyIdentity)
      await git(root, ['add', '--', 'tracked.txt'])
      const stagedWorktreeIdentity = await computeWorkspaceContentIdentity(target)
      expect(stagedWorktreeIdentity).toBe(worktreeIdentity)
      await commitAll(root, 'move HEAD tree')
      const movedHeadIdentity = await computeWorkspaceContentIdentity(target)
      expect(movedHeadIdentity).not.toBe(stagedWorktreeIdentity)

      await git(root, ['mv', 'tracked.txt', 'renamed.txt'])
      await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(movedHeadIdentity)
      await git(root, ['reset', '--hard', 'HEAD'])

      await rm(trackedPath)
      await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(movedHeadIdentity)
      await git(root, ['reset', '--hard', 'HEAD'])

      await chmod(trackedPath, 0o755)
      await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(movedHeadIdentity)
    }
  )

  it('uses the routed Git provider for remote dirty object hashes and ignores remote .orca paths', async () => {
    const calls: string[][] = []
    let remoteObjectHash = 'b'.repeat(40)
    const provider = {
      async exec(args: string[], cwd: string) {
        calls.push(args)
        expect(cwd).toBe('/srv/objective')
        if (args[0] === 'rev-parse') {
          return { stdout: `${'a'.repeat(40)}\n`, stderr: '' }
        }
        if (args[0] === 'status') {
          return { stdout: '? remote.txt\0? .orca/heimdall/objective/reports/a.json\0', stderr: '' }
        }
        if (args[0] === 'hash-object' && args.at(-1) === 'remote.txt') {
          return { stdout: `${remoteObjectHash}\n`, stderr: '' }
        }
        throw new Error(`Unexpected Git command: ${args.join(' ')}`)
      }
    }
    registerSshGitProvider('objective-content-test', provider as never)
    const runtimeTarget = {
      executionHostId: 'ssh:objective-content-test',
      worktree: {
        id: 'remote-objective',
        repoId: 'remote-objective-repo',
        path: '/srv/objective',
        git: {
          path: '/srv/objective',
          branch: 'main',
          isBare: false,
          isMainWorktree: true
        }
      } as unknown as RuntimeGitTarget['worktree']
    } satisfies RuntimeGitTarget
    const fileProvider = {
      async lstat(path: string) {
        expect(path).toBe('/srv/objective/remote.txt')
        return { type: 'file' as const, size: 8, mtime: 1 }
      }
    }
    registerSshFilesystemProvider(
      'objective-content-test',
      fileProvider as unknown as IFilesystemProvider
    )
    const target: ObjectiveWorkspaceTarget = {
      kind: 'git',
      executionHostId: 'ssh:objective-content-test',
      workspacePath: '/srv/objective',
      fileProvider: fileProvider as unknown as IFilesystemProvider,
      gitTarget: runtimeTarget
    }

    const firstIdentity = await computeWorkspaceContentIdentity(target)
    remoteObjectHash = 'c'.repeat(40)
    await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(firstIdentity)
    expect(
      calls
        .filter((args) => args[0] === 'hash-object')
        .every((args) => args.at(-1) === 'remote.txt')
    ).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'tracks executable mode changes for an untracked Git path',
    async () => {
      const root = await temporaryDirectory('orca-objective-git-mode-')
      await git(root, ['init'])
      await writeFile(join(root, 'tracked.txt'), 'committed\n')
      await commitAll(root, 'initial')
      const scriptPath = join(root, 'run.sh')
      await writeFile(scriptPath, '#!/bin/sh\nexit 0\n')
      await chmod(scriptPath, 0o644)
      const target = gitTarget(root)
      const nonExecutableIdentity = await computeWorkspaceContentIdentity(target)

      await chmod(scriptPath, 0o755)

      await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(nonExecutableIdentity)
    }
  )

  it('computes identity for an unborn Git HEAD and remains sensitive to its dirty files', async () => {
    const root = await temporaryDirectory('orca-objective-git-unborn-')
    await git(root, ['init'])
    const target = gitTarget(root)
    const emptyIdentity = await computeWorkspaceContentIdentity(target)

    await writeFile(join(root, 'first.txt'), 'first\n')

    await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(emptyIdentity)
  })

  it('fingerprints a dirty submodule without hashing its directory as a blob', async () => {
    const submoduleSource = await temporaryDirectory('orca-objective-submodule-source-')
    await git(submoduleSource, ['init'])
    await writeFile(join(submoduleSource, 'tracked.txt'), 'committed\n')
    await commitAll(submoduleSource, 'submodule initial')

    const root = await temporaryDirectory('orca-objective-submodule-parent-')
    await git(root, ['init'])
    await writeFile(join(root, 'tracked.txt'), 'committed\n')
    await commitAll(root, 'parent initial')
    await git(root, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'add',
      submoduleSource,
      'vendor/submodule'
    ])
    await commitAll(root, 'add submodule')
    const target = gitTarget(root)
    const cleanIdentity = await computeWorkspaceContentIdentity(target)
    const submoduleFile = join(root, 'vendor', 'submodule', 'tracked.txt')

    await writeFile(submoduleFile, 'dirty-one\n')
    const firstDirtyIdentity = await computeWorkspaceContentIdentity(target)
    expect(firstDirtyIdentity).not.toBe(cleanIdentity)
    await writeFile(submoduleFile, 'dirty-two\n')

    await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(firstDirtyIdentity)
  })

  it('hashes folder file contents, ignores mtimes, and excludes the complete .orca subtree', async () => {
    const root = await temporaryDirectory('orca-objective-folder-')
    await writeFile(join(root, 'a.txt'), 'a')
    const fixedTime = new Date('2026-09-15T00:00:00.000Z')
    await utimes(join(root, 'a.txt'), fixedTime, fixedTime)
    const target = folderTarget(root)
    const initialIdentity = await computeWorkspaceContentIdentity(target)

    const reportDirectory = join(root, '.orca', 'heimdall', 'objective', 'reports')
    await mkdir(reportDirectory, { recursive: true })
    await writeFile(join(reportDirectory, 'attempt.json'), 'ignored report content')
    await expect(computeWorkspaceContentIdentity(target)).resolves.toBe(initialIdentity)

    await writeFile(join(root, 'b.txt'), 'new file')
    const addedIdentity = await computeWorkspaceContentIdentity(target)
    expect(addedIdentity).not.toBe(initialIdentity)
    await utimes(
      join(root, 'b.txt'),
      new Date(fixedTime.getTime() + 60_000),
      new Date(fixedTime.getTime() + 60_000)
    )
    await expect(computeWorkspaceContentIdentity(target)).resolves.toBe(addedIdentity)

    await writeFile(join(root, 'a.txt'), 'b')
    await utimes(join(root, 'a.txt'), fixedTime, fixedTime)
    await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(addedIdentity)
  })

  it('reads remote folder contents through the filesystem provider', async () => {
    let content = 'one\n'
    const provider = {
      async readDir(path: string) {
        expect(path).toBe('/srv/objective')
        return [{ name: 'remote.txt', isDirectory: false, isSymlink: false }]
      },
      async readFile(path: string) {
        expect(path).toBe('/srv/objective/remote.txt')
        return { content, isBinary: false }
      },
      async lstat(path: string) {
        expect(path).toBe('/srv/objective/remote.txt')
        return { type: 'file' as const, size: 4, mtime: 1 }
      }
    } as unknown as IFilesystemProvider
    registerSshFilesystemProvider('objective-content-test', provider)
    const target: ObjectiveWorkspaceTarget = {
      kind: 'folder',
      executionHostId: 'ssh:objective-content-test',
      workspacePath: '/srv/objective',
      fileProvider: provider
    }
    const firstIdentity = await computeWorkspaceContentIdentity(target)

    content = 'two\n'

    await expect(computeWorkspaceContentIdentity(target)).resolves.not.toBe(firstIdentity)
  })
})

describe('computeObjectiveWorktreeContentDigest', () => {
  it.skipIf(process.platform === 'win32')(
    'tracks a symlink target even when target contents match and tolerates a broken link',
    async () => {
      const root = await temporaryDirectory('orca-objective-worktree-digest-')
      await git(root, ['init'])
      await writeFile(join(root, 'target-a.txt'), 'identical\n')
      await writeFile(join(root, 'target-b.txt'), 'identical\n')
      const link = join(root, 'current.txt')
      await symlink('target-a.txt', link)
      await commitAll(root, 'initial symlink')
      const target = gitTarget(root)
      const firstDigest = await computeObjectiveWorktreeContentDigest(target)

      await rm(link)
      await symlink('target-b.txt', link)
      const retargetedDigest = await computeObjectiveWorktreeContentDigest(target)
      expect(retargetedDigest).not.toBe(firstDigest)

      await rm(link)
      await symlink('missing.txt', link)
      await expect(computeObjectiveWorktreeContentDigest(target)).resolves.toMatch(
        /^[0-9a-f]{64}$/u
      )
    }
  )
})
