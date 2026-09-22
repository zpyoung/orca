import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import { createObjectiveNodeCommit, recoverObjectiveNodeApply } from './merge-train-git'

vi.mock('./check-runner', () => ({ runCriterionCheck: vi.fn() }))

const temporaryDirectories: string[] = []
const leaseGuard: LeaseGuard = {
  epoch: 1,
  holder: 'merge-train-recovery-test',
  assertHeld: vi.fn(async () => {}),
  renewLoop: () => ({ dispose() {} })
}

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return gitExecFileAsync(args, { cwd, admissionTier: 'background' })
}

async function gitText(cwd: string, args: string[]): Promise<string> {
  return (await git(cwd, args)).stdout.trim()
}

async function commitAll(cwd: string, message: string): Promise<string> {
  await git(cwd, ['add', '--all'])
  await git(cwd, ['commit', '-m', message])
  return gitText(cwd, ['rev-parse', 'HEAD'])
}

function target(workspacePath: string, id: string): ObjectiveWorkspaceTarget {
  const runtimeTarget = {
    executionHostId: 'local',
    worktree: {
      id,
      repoId: 'merge-train-recovery-test-repo',
      path: workspacePath,
      git: {
        path: workspacePath,
        branch: 'main',
        isBare: false,
        prunable: false,
        isMainWorktree: id === 'source'
      }
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

type RepositoryFixture = {
  source: string
  enrolled: string
  sourceTarget: ObjectiveWorkspaceTarget
  enrolledTarget: ObjectiveWorkspaceTarget
  baseCommit: string
}

async function repositoryFixture(): Promise<RepositoryFixture> {
  const parent = await mkdtemp(join(tmpdir(), 'orca-objective-recovery-'))
  temporaryDirectories.push(parent)
  const source = join(parent, 'source')
  const enrolled = join(parent, 'enrolled')
  await mkdir(source)
  await git(source, ['init'])
  await git(source, ['config', 'user.name', 'Merge Train Recovery Test'])
  await git(source, ['config', 'user.email', 'merge-train-recovery@example.test'])
  await git(source, ['config', 'commit.gpgsign', 'false'])
  await writeFile(join(source, 'shared.txt'), 'base\n')
  const baseCommit = await commitAll(source, 'base')
  await git(source, ['worktree', 'add', '--detach', enrolled, baseCommit])
  return {
    source,
    enrolled,
    sourceTarget: target(source, 'source'),
    enrolledTarget: target(enrolled, 'enrolled'),
    baseCommit
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('objective merge train recovery', () => {
  it('finds the actual rewritten commit behind later clean operator commits', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.source, 'node.txt'), 'node result\n')
    const normalized = await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'recover-node',
        title: 'Recover node',
        reportedPaths: []
      },
      leaseGuard
    )
    await writeFile(join(fixture.enrolled, 'prior.txt'), 'prior train node\n')
    await commitAll(fixture.enrolled, 'prior train node')
    await git(fixture.enrolled, ['cherry-pick', '--keep-redundant-commits', normalized.commitSha])
    const integratedHead = await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])
    expect(integratedHead).not.toBe(normalized.commitSha)
    await writeFile(join(fixture.enrolled, 'operator-one.txt'), 'one\n')
    await commitAll(fixture.enrolled, 'later clean operator commit one')
    await writeFile(join(fixture.enrolled, 'operator-two.txt'), 'two\n')
    await commitAll(fixture.enrolled, 'later clean operator commit two')
    const laterHead = await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])
    const beforeCount = await gitText(fixture.enrolled, ['rev-list', '--count', 'HEAD'])

    const result = await recoverObjectiveNodeApply(
      fixture.enrolledTarget,
      normalized.commitSha,
      leaseGuard,
      { retry: false }
    )

    expect(result).toEqual({ kind: 'applied', appliedCommitSha: integratedHead })
    expect(await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])).toBe(laterHead)
    expect(await gitText(fixture.enrolled, ['rev-list', '--count', 'HEAD'])).toBe(beforeCount)
  })

  it('reports an absent commit without starting a fresh cherry-pick when retry is disabled', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.source, 'node.txt'), 'not applied\n')
    const normalized = await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'removed-node',
        title: 'Removed node result',
        reportedPaths: []
      },
      leaseGuard
    )
    const beforeHead = await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])

    const result = await recoverObjectiveNodeApply(
      fixture.enrolledTarget,
      normalized.commitSha,
      leaseGuard,
      { retry: false }
    )

    expect(result).toEqual({ kind: 'not-applied' })
    expect(await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])).toBe(beforeHead)
    await expect(readFile(join(fixture.enrolled, 'node.txt'), 'utf8')).rejects.toBeDefined()
  })

  it('aborts its own interrupted conflict before reporting not applied in proof-only mode', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.source, 'shared.txt'), 'owned node\n')
    const normalized = await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'interrupted-node',
        title: 'Interrupted node',
        reportedPaths: []
      },
      leaseGuard
    )
    await writeFile(join(fixture.enrolled, 'shared.txt'), 'enrolled change\n')
    const enrolledHead = await commitAll(fixture.enrolled, 'enrolled change')
    await expect(git(fixture.enrolled, ['cherry-pick', normalized.commitSha])).rejects.toBeDefined()
    expect(await gitText(fixture.enrolled, ['rev-parse', 'CHERRY_PICK_HEAD'])).toBe(
      normalized.commitSha
    )

    const result = await recoverObjectiveNodeApply(
      fixture.enrolledTarget,
      normalized.commitSha,
      leaseGuard,
      { retry: false }
    )

    expect(result).toEqual({ kind: 'not-applied' })
    expect(await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])).toBe(enrolledHead)
    expect(await readFile(join(fixture.enrolled, 'shared.txt'), 'utf8')).toBe('enrolled change\n')
    expect((await git(fixture.enrolled, ['ls-files', '--unmerged'])).stdout).toBe('')
    await expect(
      git(fixture.enrolled, ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'])
    ).rejects.toBeDefined()
  })

  it('does not abort an unrelated cherry-pick', async () => {
    const fixture = await repositoryFixture()
    await writeFile(join(fixture.source, 'node.txt'), 'owned node\n')
    const normalized = await createObjectiveNodeCommit(
      fixture.sourceTarget,
      {
        baseCommit: fixture.baseCommit,
        taskKey: 'owned-node',
        title: 'Owned node',
        reportedPaths: []
      },
      leaseGuard
    )
    await git(fixture.source, ['reset', '--hard', fixture.baseCommit])
    await writeFile(join(fixture.source, 'shared.txt'), 'unrelated cherry-pick\n')
    const unrelatedCommit = await commitAll(fixture.source, 'unrelated node')
    await writeFile(join(fixture.enrolled, 'shared.txt'), 'enrolled change\n')
    await commitAll(fixture.enrolled, 'enrolled change')
    await expect(git(fixture.enrolled, ['cherry-pick', unrelatedCommit])).rejects.toBeDefined()
    expect(await gitText(fixture.enrolled, ['rev-parse', 'CHERRY_PICK_HEAD'])).toBe(unrelatedCommit)

    await expect(
      recoverObjectiveNodeApply(fixture.enrolledTarget, normalized.commitSha, leaseGuard)
    ).rejects.toThrow('different objective node commit')
    expect(await gitText(fixture.enrolled, ['rev-parse', 'CHERRY_PICK_HEAD'])).toBe(unrelatedCommit)
  })
})
