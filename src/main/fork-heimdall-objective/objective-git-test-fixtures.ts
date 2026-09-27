import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import { gitTarget } from './objective-workspace-target-test-fixtures'

export async function git(
  cwd: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return gitExecFileAsync(args, { cwd, admissionTier: 'background' })
}

export async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await git(cwd, args)).stdout.trim()
}

export async function commitAll(cwd: string, message: string): Promise<string> {
  await git(cwd, ['add', '--all'])
  await git(cwd, ['commit', '-m', message])
  return gitText(cwd, ['rev-parse', 'HEAD'])
}

export type MergeTrainRepositoryFixture = {
  source: string
  enrolled: string
  sourceTarget: ObjectiveWorkspaceTarget
  enrolledTarget: ObjectiveWorkspaceTarget
  baseCommit: string
}

export async function createMergeTrainRepositoryFixture(
  temporaryDirectories: string[],
  options: { tempPrefix: string; repoId: string; userName: string; userEmail: string }
): Promise<MergeTrainRepositoryFixture> {
  const parent = await mkdtemp(join(tmpdir(), options.tempPrefix))
  temporaryDirectories.push(parent)
  const source = join(parent, 'source')
  const enrolled = join(parent, 'enrolled')
  await mkdir(source)
  await git(source, ['init'])
  await git(source, ['config', 'user.name', options.userName])
  await git(source, ['config', 'user.email', options.userEmail])
  await git(source, ['config', 'commit.gpgsign', 'false'])
  await writeFile(join(source, 'shared.txt'), 'base\n')
  const baseCommit = await commitAll(source, 'base')
  await git(source, ['worktree', 'add', '--detach', enrolled, baseCommit])
  return {
    source,
    enrolled,
    sourceTarget: gitTarget(source, {
      id: 'source',
      repoId: options.repoId,
      isMainWorktree: true,
      prunable: false
    }),
    enrolledTarget: gitTarget(enrolled, {
      id: 'enrolled',
      repoId: options.repoId,
      isMainWorktree: false,
      prunable: false
    }),
    baseCommit
  }
}

export type LandingRepositoryFixture = {
  parent: string
  root: string
  remote: string
  target: ObjectiveWorkspaceTarget
}

export async function createLandingRepositoryFixture(
  temporaryDirectories: string[],
  options: {
    tempPrefix: string
    userName: string
    userEmail: string
    extraFiles?: Record<string, string>
  }
): Promise<LandingRepositoryFixture> {
  const parent = await mkdtemp(join(tmpdir(), options.tempPrefix))
  temporaryDirectories.push(parent)
  const root = join(parent, 'worktree')
  const remote = join(parent, 'remote.git')
  await mkdir(join(root, 'src'), { recursive: true })
  await git(root, ['init', '-b', 'main'])
  await git(root, ['config', 'user.name', options.userName])
  await git(root, ['config', 'user.email', options.userEmail])
  await git(root, ['config', 'commit.gpgsign', 'false'])
  await writeFile(join(root, 'src', 'result.txt'), 'initial\n')
  for (const [relativePath, contents] of Object.entries(options.extraFiles ?? {})) {
    await writeFile(join(root, relativePath), contents)
  }
  await git(root, ['add', '--all'])
  await git(root, ['commit', '-m', 'initial'])
  await git(parent, ['init', '--bare', remote])
  await git(root, ['remote', 'add', 'origin', remote])
  return {
    parent,
    root,
    remote,
    target: gitTarget(root, {
      id: `repo::${root}`,
      repoId: 'repo',
      isMainWorktree: true,
      prunable: false
    })
  }
}
