import { afterEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type { ObjectiveWorkspaceTarget } from '../fork-heimdall-objective/content-identity'
import type { MergeTrainRepositoryFixture } from '../fork-heimdall-objective/objective-git-test-fixtures'
import type { PipelineStore } from './pipeline-store'
import type { Worktree } from '../../shared/worktree/types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { cleanupTemporaryDirectories } from '../fork-heimdall-objective/objective-temp-workspace-test-fixtures'
import {
  createMergeTrainRepositoryFixture,
  git,
  gitText
} from '../fork-heimdall-objective/objective-git-test-fixtures'
import { gitTarget } from '../fork-heimdall-objective/objective-workspace-target-test-fixtures'
import { createInMemoryPipelineStore } from './pipeline-store-test-fixtures'
import {
  mergeChild,
  readMergeSourceFacts,
  type MergeExecutorDeps,
  type MergeChildInput
} from './merge-executor'
import { prepareConflictResolution, verifyConflictResolved } from './pipeline-merge-git'
import { cleanupChildWorktrees, pipelineChildWorktreeMarker } from './swarm-executor'

const temporaryDirectories: string[] = []
const lease: LeaseGuard = {
  epoch: 1,
  holder: 'pipeline-merge-test',
  assertHeld: async () => {},
  renewLoop: () => ({ dispose() {} })
}

afterEach(async () => {
  await cleanupTemporaryDirectories(temporaryDirectories)
})

async function childWorktree(
  fixture: MergeTrainRepositoryFixture,
  name: string,
  targets: Map<string, ObjectiveWorkspaceTarget>
): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'orca-pipeline-merge-child-'))
  temporaryDirectories.push(parent)
  const workspacePath = join(parent, name)
  await git(fixture.source, ['worktree', 'add', '--detach', workspacePath, fixture.baseCommit])
  targets.set(
    workspacePath,
    gitTarget(workspacePath, {
      id: `pipeline-merge-test::${name}`,
      repoId: 'pipeline-merge-test',
      isMainWorktree: false,
      prunable: false
    })
  )
  return workspacePath
}

function mergeDeps(
  store: PipelineStore,
  targets: Map<string, ObjectiveWorkspaceTarget>
): MergeExecutorDeps {
  return {
    store,
    lease,
    async resolveTarget(workspacePath) {
      const target = targets.get(workspacePath)
      if (!target) {
        throw new Error(`No authoritative target for ${workspacePath}`)
      }
      return target
    }
  }
}

async function mergeInput(
  fixture: MergeTrainRepositoryFixture,
  child: MergeChildInput['child'],
  deps: MergeExecutorDeps,
  overrides: Partial<MergeChildInput> = {}
): Promise<MergeChildInput> {
  const baseCommit = overrides.baseCommit ?? fixture.baseCommit
  const source = await readMergeSourceFacts(
    {
      watcherId: 'watcher-merge',
      mergeId: 'merge-node',
      epoch: 1,
      childInstanceId: child.instanceId,
      workspacePath: child.workspacePath,
      runWorkspacePath: fixture.enrolled,
      applicableBaseCommit: baseCommit,
      ...(overrides.childCommitSha === undefined
        ? {}
        : { childCommitSha: overrides.childCommitSha })
    },
    deps
  )
  return {
    watcherId: 'watcher-merge',
    mergeId: 'merge-node',
    epoch: 1,
    child,
    runWorkspacePath: fixture.enrolled,
    baseCommit,
    childCommitSha: source.committedChildSha,
    sourceHead: source.sourceHead,
    workspaceDigest: source.workspaceDigest,
    appliedChildren: [],
    ...overrides
  }
}
function recordedMergeCommit(store: PipelineStore, instanceId: string): string {
  const row = store
    .facts('watcher-merge')
    .mergeProgress.find(
      (candidate) => candidate.childInstanceId === instanceId && candidate.commitSha !== null
    )
  if (!row?.commitSha) {
    throw new Error(`Missing persisted Merge commit for ${instanceId}`)
  }
  return row.commitSha
}

async function repositoryFixture(): Promise<{
  fixture: MergeTrainRepositoryFixture
  targets: Map<string, ObjectiveWorkspaceTarget>
}> {
  const fixture = await createMergeTrainRepositoryFixture(temporaryDirectories, {
    tempPrefix: 'orca-pipeline-merge-',
    repoId: 'pipeline-merge-test',
    userName: 'Pipeline Merge Test',
    userEmail: 'pipeline-merge@example.test'
  })
  const targets = new Map<string, ObjectiveWorkspaceTarget>([
    [fixture.enrolled, fixture.enrolledTarget]
  ])
  return { fixture, targets }
}

describe('readMergeSourceFacts', () => {
  it('binds dirty child content and never treats a shared run HEAD as an isolated child commit', async () => {
    const { fixture, targets } = await repositoryFixture()
    const childPath = await childWorktree(fixture, 'facts-child', targets)
    const deps = mergeDeps(createInMemoryPipelineStore(), targets)
    await writeFile(join(childPath, 'new-file.txt'), 'first\n')

    const first = await readMergeSourceFacts(
      {
        watcherId: 'watcher-merge',
        mergeId: 'merge-node',
        epoch: 1,
        childInstanceId: 'swarm[task-a]',
        workspacePath: childPath,
        runWorkspacePath: fixture.enrolled,
        applicableBaseCommit: fixture.baseCommit
      },
      deps
    )
    await writeFile(join(childPath, 'new-file.txt'), 'changed\n')
    const changed = await readMergeSourceFacts(
      {
        watcherId: 'watcher-merge',
        mergeId: 'merge-node',
        epoch: 1,
        childInstanceId: 'swarm[task-a]',
        workspacePath: childPath,
        runWorkspacePath: fixture.enrolled,
        applicableBaseCommit: fixture.baseCommit
      },
      deps
    )
    const shared = await readMergeSourceFacts(
      {
        watcherId: 'watcher-merge',
        mergeId: 'merge-node',
        epoch: 1,
        childInstanceId: 'swarm[task-b]',
        workspacePath: null,
        runWorkspacePath: fixture.enrolled,
        applicableBaseCommit: fixture.baseCommit
      },
      deps
    )

    expect(first.sourceHead).toBe(fixture.baseCommit)
    expect(first.committedChildSha).toBeNull()
    expect(changed.workspaceDigest).not.toBe(first.workspaceDigest)
    expect(shared.sourceHead).toBe(fixture.baseCommit)
    expect(shared.committedChildSha).toBeNull()
    expect(shared.workspacePath).toBeNull()
  })
})

describe('mergeChild', () => {
  it('applies independent child commits in sequence and preserves both changes', async () => {
    const { fixture, targets } = await repositoryFixture()
    const store = createInMemoryPipelineStore()
    const deps = mergeDeps(store, targets)
    const firstPath = await childWorktree(fixture, 'first-child', targets)
    const secondPath = await childWorktree(fixture, 'second-child', targets)
    await writeFile(join(firstPath, 'first.txt'), 'first\n')
    await writeFile(join(secondPath, 'second.txt'), 'second\n')
    const first = await mergeInput(
      fixture,
      { instanceId: 'swarm[first]', taskId: 'first', workspacePath: firstPath },
      deps
    )
    const second = await mergeInput(
      fixture,
      { instanceId: 'swarm[second]', taskId: 'second', workspacePath: secondPath },
      deps
    )

    const firstApplied = await mergeChild(first, deps)
    expect(firstApplied.status).toBe('applied')
    const secondApplied = await mergeChild(
      {
        ...second,
        appliedChildren: [
          { taskId: 'first', commitSha: recordedMergeCommit(store, 'swarm[first]') }
        ]
      },
      deps
    )

    expect(secondApplied.status).toBe('applied')
    expect(await gitText(fixture.enrolled, ['show', 'HEAD:first.txt'])).toBe('first')
    expect(await gitText(fixture.enrolled, ['show', 'HEAD:second.txt'])).toBe('second')
    expect(store.facts('watcher-merge').mergeProgress.map((row) => row.state)).toEqual([
      'applied',
      'applied'
    ])
  })

  it('does not apply child content changed after its action evidence was captured', async () => {
    const { fixture, targets } = await repositoryFixture()
    const store = createInMemoryPipelineStore()
    const deps = mergeDeps(store, targets)
    const childPath = await childWorktree(fixture, 'stale-source', targets)
    await writeFile(join(childPath, 'shared.txt'), 'captured\n')
    const action = await mergeInput(
      fixture,
      { instanceId: 'swarm[stale]', taskId: 'stale', workspacePath: childPath },
      deps
    )
    await writeFile(join(childPath, 'shared.txt'), 'changed after tick\n')

    const applied = await mergeChild(action, deps).then(
      () => true,
      () => false
    )

    expect(applied).toBe(false)
    expect(await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])).toBe(fixture.baseCommit)
    expect(store.facts('watcher-merge').mergeProgress).toEqual([])
  })

  it('never publishes protected .orca changes from a child commit', async () => {
    const { fixture, targets } = await repositoryFixture()
    const store = createInMemoryPipelineStore()
    const deps = mergeDeps(store, targets)
    const childPath = await childWorktree(fixture, 'protected-child', targets)
    await mkdir(join(childPath, '.orca', 'pipelines'), { recursive: true })
    await writeFile(join(childPath, '.orca', 'pipelines', 'secret.yaml'), 'private\n')
    await writeFile(join(childPath, 'visible.txt'), 'visible\n')
    const child = await mergeInput(
      fixture,
      { instanceId: 'swarm[protected]', taskId: 'protected', workspacePath: childPath },
      deps
    )

    const applied = await mergeChild(child, deps)

    expect(applied.status).toBe('applied')
    expect(await gitText(fixture.enrolled, ['show', 'HEAD:visible.txt'])).toBe('visible')
    expect(
      await gitText(fixture.enrolled, ['ls-tree', '-r', '--name-only', 'HEAD', '--', '.orca'])
    ).toBe('')
    expect(await readFile(join(childPath, '.orca', 'pipelines', 'secret.yaml'), 'utf8')).toBe(
      'private\n'
    )
  })

  it('attributes a conflicting path to its applied child and resolves once on the child worktree', async () => {
    const { fixture, targets } = await repositoryFixture()
    const store = createInMemoryPipelineStore()
    const deps = mergeDeps(store, targets)
    const firstPath = await childWorktree(fixture, 'conflict-first', targets)
    const secondPath = await childWorktree(fixture, 'conflict-second', targets)
    await writeFile(join(firstPath, 'shared.txt'), 'first child\n')
    await writeFile(join(secondPath, 'shared.txt'), 'second child\n')
    const first = await mergeInput(
      fixture,
      { instanceId: 'swarm[first]', taskId: 'first', workspacePath: firstPath },
      deps
    )
    const second = await mergeInput(
      fixture,
      { instanceId: 'swarm[second]', taskId: 'second', workspacePath: secondPath },
      deps
    )
    const firstApplied = await mergeChild(first, deps)
    if (firstApplied.status !== 'applied') {
      throw new Error('Expected the first child to apply cleanly')
    }
    const firstCommitSha = recordedMergeCommit(store, 'swarm[first]')
    const conflict = await mergeChild(
      {
        ...second,
        appliedChildren: [{ taskId: 'first', commitSha: firstCommitSha }]
      },
      deps
    )
    if (conflict.status !== 'conflict') {
      throw new Error('Expected the second child to conflict with the first')
    }
    const secondCommitSha = recordedMergeCommit(store, 'swarm[second]')

    expect(conflict.conflictPaths).toEqual(['shared.txt'])
    expect(conflict.conflictingChildren).toEqual(['first'])
    expect(await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])).toBe(
      firstApplied.appliedCommitSha
    )
    const resolution = await prepareConflictResolution(
      {
        childWorkspacePath: secondPath,
        mergedHead: firstApplied.appliedCommitSha,
        childCommitSha: secondCommitSha
      },
      deps
    )
    expect(resolution).toEqual({ status: 'conflict-in-place' })
    expect(await gitText(secondPath, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'])).toBe(
      secondCommitSha
    )
    expect(await readFile(join(secondPath, 'shared.txt'), 'utf8')).toContain('<<<<<<<')
    expect(
      await verifyConflictResolved(
        { childWorkspacePath: secondPath, conflictPaths: conflict.conflictPaths },
        deps
      )
    ).toBe(false)

    await writeFile(join(secondPath, 'shared.txt'), 'resolved child\n')
    await git(secondPath, ['add', '--all', '--', 'shared.txt'])
    expect(
      await verifyConflictResolved(
        { childWorkspacePath: secondPath, conflictPaths: conflict.conflictPaths },
        deps
      )
    ).toBe(true)
    store.setMergeProgress({
      watcherId: 'watcher-merge',
      mergeId: 'merge-node',
      epoch: 1,
      childInstanceId: 'swarm[second]',
      state: 'resolved'
    })
    const resolvedAction = await mergeInput(fixture, second.child, deps, {
      baseCommit: firstApplied.appliedCommitSha,
      appliedChildren: [{ taskId: 'first', commitSha: firstCommitSha }]
    })
    const resolvedApplied = await mergeChild(resolvedAction, deps)

    expect(resolvedApplied.status).toBe('applied')
    expect(await gitText(fixture.enrolled, ['show', 'HEAD:shared.txt'])).toBe('resolved child')
    await git(fixture.enrolled, [
      'merge-base',
      '--is-ancestor',
      firstApplied.appliedCommitSha,
      'HEAD'
    ])
    expect(
      store
        .facts('watcher-merge')
        .mergeProgress.find((row) => row.childInstanceId === 'swarm[first]')?.state
    ).toBe('applied')
  })

  it('recovers a cleanly prepared resolver without resetting or cherry-picking twice', async () => {
    const { fixture, targets } = await repositoryFixture()
    const store = createInMemoryPipelineStore()
    const deps = mergeDeps(store, targets)
    const firstPath = await childWorktree(fixture, 'clean-prepare-first', targets)
    const secondPath = await childWorktree(fixture, 'clean-prepare-second', targets)
    await writeFile(join(firstPath, 'shared.txt'), 'first child\n')
    await writeFile(join(secondPath, 'shared.txt'), 'second child\n')
    const first = await mergeInput(
      fixture,
      { instanceId: 'swarm[first]', taskId: 'first', workspacePath: firstPath },
      deps
    )
    const second = await mergeInput(
      fixture,
      { instanceId: 'swarm[second]', taskId: 'second', workspacePath: secondPath },
      deps
    )
    const firstApplied = await mergeChild(first, deps)
    if (firstApplied.status !== 'applied') {
      throw new Error('Expected the first child to apply cleanly')
    }
    const firstCommitSha = recordedMergeCommit(store, 'swarm[first]')
    const conflict = await mergeChild(
      {
        ...second,
        appliedChildren: [{ taskId: 'first', commitSha: firstCommitSha }]
      },
      deps
    )
    if (conflict.status !== 'conflict') {
      throw new Error('Expected the second child to conflict')
    }
    const secondCommitSha = recordedMergeCommit(store, 'swarm[second]')
    await writeFile(join(fixture.enrolled, 'shared.txt'), 'base\n')
    await git(fixture.enrolled, ['add', '--all', '--', 'shared.txt'])
    await git(fixture.enrolled, ['commit', '-m', 'reconciled merge head'])
    const mergedHead = await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])
    store.setMergeProgress({
      watcherId: 'watcher-merge',
      mergeId: 'merge-node',
      epoch: 1,
      childInstanceId: 'swarm[second]',
      state: 'resolving'
    })

    const prepared = await prepareConflictResolution(
      { childWorkspacePath: secondPath, mergedHead, childCommitSha: secondCommitSha },
      deps
    )
    const preparedHead = await gitText(secondPath, ['rev-parse', 'HEAD'])
    const recovered = await prepareConflictResolution(
      { childWorkspacePath: secondPath, mergedHead, childCommitSha: secondCommitSha },
      deps
    )

    expect(prepared).toEqual({ status: 'applied-cleanly' })
    expect(recovered).toEqual({ status: 'applied-cleanly' })
    expect(await gitText(secondPath, ['rev-parse', 'HEAD'])).toBe(preparedHead)
    expect(await gitText(secondPath, ['rev-parse', 'HEAD^'])).toBe(mergedHead)
    expect(await gitText(secondPath, ['show', 'HEAD:shared.txt'])).toBe('second child')
  })

  it('refuses a dirty child worktree before conflict preparation and preserves its contents', async () => {
    const { fixture, targets } = await repositoryFixture()
    const store = createInMemoryPipelineStore()
    const deps = mergeDeps(store, targets)
    const childPath = await childWorktree(fixture, 'dirty-prepare-child', targets)
    await writeFile(join(childPath, 'result.txt'), 'child result\n')
    const child = await mergeInput(
      fixture,
      { instanceId: 'swarm[dirty]', taskId: 'dirty', workspacePath: childPath },
      deps
    )
    const applied = await mergeChild(child, deps)
    if (applied.status !== 'applied') {
      throw new Error('Expected the child commit to apply cleanly')
    }
    const childCommitSha = recordedMergeCommit(store, 'swarm[dirty]')
    const runHead = await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])
    await writeFile(join(childPath, 'uncommitted.txt'), 'preserve me\n')
    const childHead = await gitText(childPath, ['rev-parse', 'HEAD'])
    const preparation = await prepareConflictResolution(
      {
        childWorkspacePath: childPath,
        mergedHead: runHead,
        childCommitSha
      },
      deps
    ).then(
      () => 'prepared',
      () => 'refused'
    )

    expect(preparation).toBe('refused')
    expect(await readFile(join(childPath, 'uncommitted.txt'), 'utf8')).toBe('preserve me\n')
    expect(await gitText(childPath, ['rev-parse', 'HEAD'])).toBe(childHead)
    expect(await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])).toBe(runHead)
  })

  it('applies an explicit isolated commit for a shared child and reports conflict without a child workspace', async () => {
    const { fixture, targets } = await repositoryFixture()
    const store = createInMemoryPipelineStore()
    const deps = mergeDeps(store, targets)
    const firstPath = await childWorktree(fixture, 'shared-first', targets)
    const isolatedPath = await childWorktree(fixture, 'shared-conflict-source', targets)
    await writeFile(join(firstPath, 'shared.txt'), 'first\n')
    await writeFile(join(isolatedPath, 'shared.txt'), 'second\n')
    const first = await mergeInput(
      fixture,
      { instanceId: 'swarm[first]', taskId: 'first', workspacePath: firstPath },
      deps
    )
    const firstApplied = await mergeChild(first, deps)
    if (firstApplied.status !== 'applied') {
      throw new Error('Expected the first child to apply cleanly')
    }
    const firstCommitSha = recordedMergeCommit(store, 'swarm[first]')
    await git(isolatedPath, ['add', '--all', '--', 'shared.txt'])
    await git(isolatedPath, ['commit', '-m', 'isolated child'])
    const isolatedCommitSha = await gitText(isolatedPath, ['rev-parse', 'HEAD'])
    const sharedAction = await mergeInput(
      fixture,
      { instanceId: 'swarm[second]', taskId: 'second', workspacePath: null },
      deps,
      {
        childCommitSha: isolatedCommitSha,
        appliedChildren: [{ taskId: 'first', commitSha: firstCommitSha }]
      }
    )
    const sharedConflict = await mergeChild(sharedAction, deps)

    expect(sharedConflict).toEqual({
      status: 'conflict',
      conflictPaths: ['shared.txt'],
      conflictingChildren: ['first']
    })
    expect(
      store
        .facts('watcher-merge')
        .mergeProgress.find((row) => row.childInstanceId === 'swarm[second]')
    ).toMatchObject({ state: 'conflict', commitSha: isolatedCommitSha })
    expect(await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])).toBe(
      firstApplied.appliedCommitSha
    )
  })

  it('leaves shared-worktree output in place when no isolated commit exists', async () => {
    const { fixture, targets } = await repositoryFixture()
    const store = createInMemoryPipelineStore()
    const deps = mergeDeps(store, targets)
    const beforeHead = await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])
    await writeFile(join(fixture.enrolled, 'shared-output.txt'), 'already in run workspace\n')
    const sharedAction = await mergeInput(
      fixture,
      { instanceId: 'swarm[shared]', taskId: 'shared', workspacePath: null },
      deps
    )

    const result = await mergeChild(sharedAction, deps)

    expect(result).toEqual({ status: 'applied', appliedCommitSha: beforeHead })
    expect(await readFile(join(fixture.enrolled, 'shared-output.txt'), 'utf8')).toBe(
      'already in run workspace\n'
    )
    expect(await gitText(fixture.enrolled, ['rev-parse', 'HEAD'])).toBe(beforeHead)
  })

  it('reports an existing shared-worktree conflict without resetting its in-progress cherry-pick', async () => {
    const { fixture, targets } = await repositoryFixture()
    const store = createInMemoryPipelineStore()
    const deps = mergeDeps(store, targets)
    const firstPath = await childWorktree(fixture, 'shared-index-first', targets)
    const secondPath = await childWorktree(fixture, 'shared-index-second', targets)
    await writeFile(join(firstPath, 'shared.txt'), 'first\n')
    await writeFile(join(secondPath, 'shared.txt'), 'second\n')
    const first = await mergeInput(
      fixture,
      { instanceId: 'swarm[first]', taskId: 'first', workspacePath: firstPath },
      deps
    )
    const firstApplied = await mergeChild(first, deps)
    if (firstApplied.status !== 'applied') {
      throw new Error('Expected the first child to apply cleanly')
    }
    const firstCommitSha = recordedMergeCommit(store, 'swarm[first]')
    await git(secondPath, ['add', '--all', '--', 'shared.txt'])
    await git(secondPath, ['commit', '-m', 'shared child'])
    const secondCommitSha = await gitText(secondPath, ['rev-parse', 'HEAD'])
    const cherryPickFailed = await git(fixture.enrolled, [
      'cherry-pick',
      '--keep-redundant-commits',
      secondCommitSha
    ]).then(
      () => false,
      () => true
    )
    if (!cherryPickFailed) {
      throw new Error('Expected the run worktree to have an unmerged shared child')
    }
    const sharedAction = await mergeInput(
      fixture,
      { instanceId: 'swarm[second]', taskId: 'second', workspacePath: null },
      deps,
      { appliedChildren: [{ taskId: 'first', commitSha: firstCommitSha }] }
    )

    const sharedConflict = await mergeChild(sharedAction, deps)

    expect(sharedConflict).toEqual({
      status: 'conflict',
      conflictPaths: ['shared.txt'],
      conflictingChildren: ['first']
    })
    expect(await gitText(fixture.enrolled, ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'])).toBe(
      secondCommitSha
    )
  })
})

describe('cleanupChildWorktrees', () => {
  it('removes applied children early and preserves pending children until the run is terminal', async () => {
    const { fixture } = await repositoryFixture()
    const store = createInMemoryPipelineStore()
    const appliedPath = await childWorktree(fixture, 'cleanup-applied', new Map())
    const pendingPath = await childWorktree(fixture, 'cleanup-pending', new Map())
    const appliedId = `pipeline-merge-test::cleanup-applied`
    const pendingId = `pipeline-merge-test::cleanup-pending`
    const appliedTarget = gitTarget(appliedPath, {
      id: appliedId,
      repoId: 'pipeline-merge-test',
      isMainWorktree: false,
      prunable: false
    })
    const pendingTarget = gitTarget(pendingPath, {
      id: pendingId,
      repoId: 'pipeline-merge-test',
      isMainWorktree: false,
      prunable: false
    })
    if (!appliedTarget.gitTarget || !pendingTarget.gitTarget) {
      throw new Error('Expected Git child targets')
    }
    const worktrees = new Map<string, Worktree>([
      [
        appliedId,
        {
          ...appliedTarget.gitTarget.worktree,
          comment: pipelineChildWorktreeMarker({
            watcherId: 'watcher-cleanup',
            instanceId: 'swarm[applied]',
            epoch: 1
          })
        }
      ],
      [
        pendingId,
        {
          ...pendingTarget.gitTarget.worktree,
          comment: pipelineChildWorktreeMarker({
            watcherId: 'watcher-cleanup',
            instanceId: 'swarm[pending]',
            epoch: 1
          })
        }
      ]
    ])
    const runtime = {
      listManagedWorktrees: async () => ({
        worktrees: [],
        totalCount: 0,
        truncated: false,
        hostScope: { hostIds: ['local'], omittedHostIds: [] }
      }),
      showManagedWorktree: async (selector: string) => {
        const worktree = worktrees.get(selector.replace(/^id:/u, ''))
        if (!worktree) {
          throw new Error('selector_not_found')
        }
        return worktree
      },
      removeManagedWorktree: async (selector: string) => {
        const id = selector.replace(/^id:/u, '')
        const worktree = worktrees.get(id)
        if (worktree) {
          await git(fixture.source, ['worktree', 'remove', '--force', worktree.path])
          worktrees.delete(id)
        }
        return {}
      }
    } satisfies Pick<
      OrcaRuntimeService,
      'showManagedWorktree' | 'removeManagedWorktree' | 'listManagedWorktrees'
    >
    store.recordChildWorktree({
      watcherId: 'watcher-cleanup',
      instanceId: 'swarm[applied]',
      epoch: 1,
      worktreeId: appliedId,
      setupState: 'ready'
    })
    store.recordChildWorktree({
      watcherId: 'watcher-cleanup',
      instanceId: 'swarm[pending]',
      epoch: 1,
      worktreeId: pendingId,
      setupState: 'ready'
    })
    store.setMergeProgress({
      watcherId: 'watcher-cleanup',
      mergeId: 'merge',
      epoch: 1,
      childInstanceId: 'swarm[applied]',
      state: 'applied',
      commitSha: fixture.baseCommit,
      appliedCommitSha: fixture.baseCommit
    })

    expect(
      await cleanupChildWorktrees(
        { watcherId: 'watcher-cleanup', terminal: false },
        { runtime, store }
      )
    ).toBe(true)
    await expect(lstat(appliedPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(pendingPath)).resolves.toBeDefined()
    expect(store.facts('watcher-cleanup').childWorktrees.map((row) => row.setupState)).toEqual([
      'removed',
      'ready'
    ])

    expect(
      await cleanupChildWorktrees(
        { watcherId: 'watcher-cleanup', terminal: true },
        { runtime, store }
      )
    ).toBe(true)
    await expect(lstat(pendingPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(store.facts('watcher-cleanup').childWorktrees.map((row) => row.setupState)).toEqual([
      'removed',
      'removed'
    ])
  })
})
