import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeManagedWorktreeCreateArgs } from '../runtime/runtime-managed-worktree-create-types'
import type { Worktree } from '../../shared/worktree/types'
import { createInMemoryPipelineStore } from './pipeline-store-test-fixtures'
import { cleanupTemporaryDirectories } from '../fork-heimdall-objective/objective-temp-workspace-test-fixtures'
import {
  createMergeTrainRepositoryFixture,
  git,
  gitText
} from '../fork-heimdall-objective/objective-git-test-fixtures'
import { gitTarget } from '../fork-heimdall-objective/objective-workspace-target-test-fixtures'
import { expandSwarm, pipelineChildWorktreeMarker, prepareChildWorktree } from './swarm-executor'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await cleanupTemporaryDirectories(temporaryDirectories)
})
async function temporaryChildPath(name: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'orca-pipeline-child-'))
  temporaryDirectories.push(parent)
  return join(parent, name)
}

describe('expandSwarm', () => {
  it('rejects empty task lists with lint diagnostics', async () => {
    const store = createInMemoryPipelineStore()

    await expect(
      expandSwarm(
        {
          watcherId: 'watcher-empty',
          swarmId: 'swarm',
          epoch: 1,
          tasks: [],
          runWorkspacePath: '/unused'
        },
        { store, readHead: async () => 'a'.repeat(40) }
      )
    ).resolves.toEqual({ status: 'lint-failed', errors: [{ code: 'empty' }] })
  })
  it('reports unknown dependencies and rejects oversized task lists before recording an expansion', async () => {
    const store = createInMemoryPipelineStore()
    const deps = { store, readHead: async () => 'a'.repeat(40) }
    const unknownDependency = await expandSwarm(
      {
        watcherId: 'watcher-invalid',
        swarmId: 'swarm',
        epoch: 1,
        tasks: [{ id: 'dependent', title: 'Dependent', spec: 'task', deps: ['missing'] }],
        runWorkspacePath: '/unused'
      },
      deps
    )
    const oversized = await expandSwarm(
      {
        watcherId: 'watcher-oversized',
        swarmId: 'swarm',
        epoch: 1,
        tasks: Array.from({ length: 21 }, (_, index) => ({
          id: `task-${index}`,
          title: `Task ${index}`,
          spec: 'task'
        })),
        runWorkspacePath: '/unused'
      },
      deps
    )

    expect(unknownDependency).toEqual({
      status: 'lint-failed',
      errors: [{ code: 'unknown-dep', taskId: 'dependent', dependencyId: 'missing' }]
    })
    expect(oversized).toEqual({ status: 'lint-failed', errors: [{ code: 'too-many' }] })
    expect(store.facts('watcher-invalid').swarmExpansions).toEqual([])
    expect(store.facts('watcher-oversized').swarmExpansions).toEqual([])
  })

  it('persists a valid dependency graph, exact run HEAD and overlap warnings', async () => {
    const fixture = await createMergeTrainRepositoryFixture(temporaryDirectories, {
      tempPrefix: 'orca-pipeline-swarm-',
      repoId: 'pipeline-swarm-test',
      userName: 'Pipeline Swarm Test',
      userEmail: 'pipeline-swarm@example.test'
    })
    const store = createInMemoryPipelineStore()
    const tasks = [
      { id: 'first', title: 'First', spec: 'one', territory: ['src/shared.ts'] },
      { id: 'second', title: 'Second', spec: 'two', territory: ['./src/shared.ts'] },
      { id: 'third', title: 'Third', spec: 'three', deps: ['first'] },
      { id: 'fourth', title: 'Fourth', spec: 'four', deps: ['second'] }
    ]

    await expect(
      expandSwarm(
        {
          watcherId: 'watcher-swarm',
          swarmId: 'swarm',
          epoch: 3,
          tasks,
          runWorkspacePath: fixture.enrolled
        },
        { store, readHead: async (path) => gitText(path, ['rev-parse', 'HEAD']) }
      )
    ).resolves.toEqual({
      status: 'expanded',
      warnings: [
        {
          code: 'territory-overlap',
          taskIds: ['first', 'second'],
          paths: ['src/shared.ts']
        }
      ]
    })
    expect(store.facts('watcher-swarm').swarmExpansions).toEqual([
      {
        swarmId: 'swarm',
        epoch: 3,
        tasks,
        warnings: [
          {
            code: 'territory-overlap',
            taskIds: ['first', 'second'],
            paths: ['src/shared.ts']
          }
        ],
        baseCommit: fixture.baseCommit
      }
    ])
  })
})

describe('prepareChildWorktree', () => {
  it('creates an own child at the exact base, recovers it by identity and records it once', async () => {
    const fixture = await createMergeTrainRepositoryFixture(temporaryDirectories, {
      tempPrefix: 'orca-pipeline-child-',
      repoId: 'pipeline-child-test',
      userName: 'Pipeline Child Test',
      userEmail: 'pipeline-child@example.test'
    })
    const store = createInMemoryPipelineStore()
    store.recordSwarmExpansion({
      watcherId: 'watcher-child',
      swarmId: 'swarm',
      epoch: 2,
      tasks: [{ id: 'task-a', title: 'Task A', spec: 'task' }],
      warnings: [],
      baseCommit: fixture.baseCommit
    })
    const childPath = await temporaryChildPath('managed-child')
    const managed = new Map<string, Worktree>()
    const createManagedWorktree = async (args: RuntimeManagedWorktreeCreateArgs) => {
      if (!args.baseBranch) {
        throw new Error('missing base commit')
      }
      await git(fixture.source, ['worktree', 'add', '--detach', childPath, args.baseBranch])
      const target = gitTarget(childPath, {
        id: 'pipeline-child-test::managed-child',
        repoId: 'pipeline-child-test',
        isMainWorktree: false,
        prunable: false
      })
      if (!target.gitTarget) {
        throw new Error('missing Git target')
      }
      const worktree = {
        ...target.gitTarget.worktree,
        head: args.baseBranch,
        comment: args.comment ?? '',
        git: { ...target.gitTarget.worktree.git, head: args.baseBranch }
      }
      managed.set(worktree.id, worktree)
      return { worktree }
    }
    const runtime = {
      createManagedWorktree,
      listManagedWorktrees: async () => ({
        worktrees: [],
        totalCount: 0,
        truncated: false,
        hostScope: { hostIds: ['local'], omittedHostIds: [] }
      }),
      showManagedWorktree: async (selector: string) => {
        const id = selector.startsWith('id:') ? selector.slice(3) : selector
        const worktree = managed.get(id)
        if (!worktree) {
          throw new Error('selector_not_found')
        }
        return worktree
      },
      removeManagedWorktree: async (selector: string) => {
        const id = selector.startsWith('id:') ? selector.slice(3) : selector
        const worktree = managed.get(id)
        if (worktree) {
          await git(fixture.source, ['worktree', 'remove', '--force', worktree.path])
          managed.delete(id)
        }
        return {}
      }
    } satisfies Pick<
      OrcaRuntimeService,
      | 'createManagedWorktree'
      | 'listManagedWorktrees'
      | 'showManagedWorktree'
      | 'removeManagedWorktree'
    >
    const input = {
      watcherId: 'watcher-child',
      instanceId: 'swarm[task-a]',
      epoch: 2,
      repoId: 'pipeline-child-test',
      baseCommit: fixture.baseCommit
    }

    const first = await prepareChildWorktree(input, { runtime, store })
    const second = await prepareChildWorktree(input, { runtime, store })

    expect(await gitText(first.workspacePath, ['rev-parse', 'HEAD'])).toBe(fixture.baseCommit)
    expect(second).toEqual(first)
    expect(store.facts('watcher-child').childWorktrees).toEqual([
      {
        instanceId: 'swarm[task-a]',
        epoch: 2,
        worktreeId: 'pipeline-child-test::managed-child',
        setupState: 'ready'
      }
    ])
  })
  it('recovers a managed worktree left behind before its store row was written', async () => {
    const fixture = await createMergeTrainRepositoryFixture(temporaryDirectories, {
      tempPrefix: 'orca-pipeline-child-recovery-',
      repoId: 'pipeline-child-test',
      userName: 'Pipeline Child Recovery Test',
      userEmail: 'pipeline-child-recovery@example.test'
    })
    const store = createInMemoryPipelineStore()
    store.recordSwarmExpansion({
      watcherId: 'watcher-child-recovery',
      swarmId: 'swarm',
      epoch: 5,
      tasks: [{ id: 'task-recovered', title: 'Recovered', spec: 'task' }],
      warnings: [],
      baseCommit: fixture.baseCommit
    })
    const childPath = await temporaryChildPath('orphan-child')
    const input = {
      watcherId: 'watcher-child-recovery',
      instanceId: 'swarm[task-recovered]',
      epoch: 5,
      repoId: 'pipeline-child-test',
      baseCommit: fixture.baseCommit
    }
    await git(fixture.source, ['worktree', 'add', '--detach', childPath, fixture.baseCommit])
    const target = gitTarget(childPath, {
      id: 'pipeline-child-test::orphan-child',
      repoId: 'pipeline-child-test',
      isMainWorktree: false,
      prunable: false
    })
    if (!target.gitTarget) {
      throw new Error('Expected the recovered worktree to be a Git target')
    }
    const recoveredWorktree = {
      ...target.gitTarget.worktree,
      head: fixture.baseCommit,
      comment: pipelineChildWorktreeMarker(input),
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: { ...target.gitTarget.worktree.git, head: fixture.baseCommit }
    }
    const runtime = {
      createManagedWorktree: async () => {
        throw new Error('A matching managed child already exists')
      },
      listManagedWorktrees: async () => ({
        worktrees: [recoveredWorktree],
        totalCount: 1,
        truncated: false,
        hostScope: { hostIds: ['local'], omittedHostIds: [] }
      }),
      showManagedWorktree: async () => recoveredWorktree,
      removeManagedWorktree: async () => ({})
    } satisfies Pick<
      OrcaRuntimeService,
      | 'createManagedWorktree'
      | 'listManagedWorktrees'
      | 'showManagedWorktree'
      | 'removeManagedWorktree'
    >

    const recovered = await prepareChildWorktree(input, { runtime, store })

    expect(await gitText(recovered.workspacePath, ['rev-parse', 'HEAD'])).toBe(fixture.baseCommit)
    expect(recovered).toEqual({
      worktreeId: 'pipeline-child-test::orphan-child',
      workspacePath: childPath
    })
    expect(store.facts('watcher-child-recovery').childWorktrees).toEqual([
      {
        instanceId: 'swarm[task-recovered]',
        epoch: 5,
        worktreeId: recovered.worktreeId,
        setupState: 'ready'
      }
    ])
  })
})
