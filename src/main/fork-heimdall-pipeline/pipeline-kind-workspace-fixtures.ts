import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import { gitExecFileAsync } from '../git/command-runner/git-exec-file'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeManagedWorktreeCreateArgs } from '../runtime/runtime-managed-worktree-create-types'
import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'

export type PipelineKindWorkspaceOptions = Readonly<{
  workspaceKind?: 'git' | 'folder'
  repoExecutionHostId?: Repo['executionHostId']
}>

export type PipelineKindWorkspaceFixture = Readonly<{
  root: string
  profile: string
  workspacePath: string
  repoId: string
  worktreeId: string | null
  workspaceKind: 'git' | 'folder'
  runtime: OrcaRuntimeService
  store: Store
  createdWorktreePaths: string[]
  resolveGitTarget(worktreeId: string): Promise<RuntimeGitTarget>
  gitWorktreePaths(): Promise<string[]>
}>

async function runGit(cwd: string, args: string[]): Promise<string> {
  return (await gitExecFileAsync(args, { cwd, admissionTier: 'background' })).stdout.trim()
}

export async function createPipelineKindWorkspaceFixture(
  options: PipelineKindWorkspaceOptions = {}
): Promise<PipelineKindWorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), 'orca-pipeline-kind-'))
  try {
    const workspaceKind = options.workspaceKind ?? 'git'
    const profile = join(root, 'profile')
    const createdWorkspacePath = join(root, 'workspace')
    await mkdir(profile, { recursive: true })
    await mkdir(createdWorkspacePath, { recursive: true })
    await writeFile(join(createdWorkspacePath, 'README.txt'), 'Pipeline integration workspace.\n')
    if (workspaceKind === 'git') {
      await runGit(createdWorkspacePath, ['init', '-b', 'main'])
      await runGit(createdWorkspacePath, ['config', 'user.name', 'Pipeline Test'])
      await runGit(createdWorkspacePath, ['config', 'user.email', 'pipeline-test@example.test'])
      await runGit(createdWorkspacePath, ['config', 'commit.gpgsign', 'false'])
      await runGit(createdWorkspacePath, ['add', 'README.txt'])
      await runGit(createdWorkspacePath, [
        '-c',
        'user.name=Pipeline Test',
        '-c',
        'user.email=pipeline-test@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'initial'
      ])
    }
    const workspacePath = await realpath(createdWorkspacePath)
    const repoId = 'pipeline-test-repo'
    const worktreeId = workspaceKind === 'git' ? `${repoId}::${workspacePath}` : null
    const head = workspaceKind === 'git' ? await runGit(workspacePath, ['rev-parse', 'HEAD']) : ''
    const repo: Repo = {
      id: repoId,
      path: workspacePath,
      displayName: 'Pipeline Test Repository',
      badgeColor: '#000000',
      addedAt: 1,
      kind: workspaceKind,
      executionHostId: options.repoExecutionHostId ?? 'local'
    }
    const worktree = {
      id: worktreeId ?? `${repoId}::${workspacePath}`,
      repoId,
      path: workspacePath,
      git: {
        path: workspacePath,
        head,
        branch: workspaceKind === 'git' ? 'main' : '',
        isBare: false,
        prunable: false,
        isMainWorktree: true
      },
      head,
      branch: workspaceKind === 'git' ? 'main' : '',
      isBare: false,
      isMainWorktree: true,
      displayName: 'Pipeline Test Workspace',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0
    }
    const executionHostId = options.repoExecutionHostId ?? 'local'
    const runtimeTarget: RuntimeGitTarget = { worktree, repo, executionHostId }
    const runtimeTargets = new Map<string, RuntimeGitTarget>([[worktree.id, runtimeTarget]])
    let nextManagedWorktree = 0
    const resolveTarget = (selector: string): RuntimeGitTarget => {
      const id = selector.startsWith('id:') ? selector.slice('id:'.length) : selector
      const target = runtimeTargets.get(id)
      if (target === undefined) {
        throw new Error(`selector_not_found: ${selector}`)
      }
      return target
    }
    const createdWorktreePaths: string[] = []
    // SAFETY: this fixture provides the host-owned worktree catalogue and the target resolvers used by the real enrollment/tick path.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: OrcaRuntimeService has private state; these methods resolve tracked targets and perform real Git worktree add/remove operations.
    const runtime = {
      resolveRuntimeGitTarget: vi.fn(async (selector: string) => resolveTarget(selector)),
      resolveRuntimeFileTarget: vi.fn(async (selector: string) => resolveTarget(selector)),
      invalidateWorktreeCatalog: vi.fn(),
      listManagedWorktrees: vi.fn(async (selector?: string) => {
        if (selector !== undefined && selector !== repoId && selector !== `id:${repoId}`) {
          throw new Error(`selector_not_found: ${selector}`)
        }
        const targets = [...runtimeTargets.values()]
        const worktrees = targets.map((target) => ({
          ...target.worktree,
          parentWorktreeId: null,
          childWorktreeIds: [],
          lineage: null,
          workspaceLineage: null
        }))
        return {
          worktrees,
          totalCount: worktrees.length,
          truncated: false,
          hostScope: {
            hostIds: [...new Set(targets.map((target) => target.executionHostId))].sort(),
            omittedHostIds: []
          }
        }
      }),
      createManagedWorktree: async (args: RuntimeManagedWorktreeCreateArgs) => {
        if (workspaceKind !== 'git' || executionHostId !== 'local') {
          throw new Error('The pipeline test runtime only creates local Git worktrees')
        }
        if (args.repoSelector !== `id:${repoId}`) {
          throw new Error(`selector_not_found: ${args.repoSelector}`)
        }
        const createdRoot = join(root, 'managed-worktrees', `worktree-${++nextManagedWorktree}`)
        await mkdir(dirname(createdRoot), { recursive: true })
        await runGit(workspacePath, [
          'worktree',
          'add',
          '--detach',
          createdRoot,
          ...(args.baseBranch === undefined ? [] : [args.baseBranch])
        ])
        const createdPath = await realpath(createdRoot)
        createdWorktreePaths.push(createdPath)
        const createdHead = await runGit(createdPath, ['rev-parse', 'HEAD'])
        const createdWorktree = {
          ...worktree,
          id: `${repoId}::${createdPath}`,
          path: createdPath,
          git: {
            ...worktree.git,
            path: createdPath,
            head: createdHead,
            branch: 'HEAD',
            isMainWorktree: false
          },
          head: createdHead,
          branch: 'HEAD',
          isMainWorktree: false,
          displayName: args.displayName ?? args.name,
          comment: args.comment ?? ''
        }
        const createdTarget: RuntimeGitTarget = {
          worktree: createdWorktree,
          repo,
          executionHostId
        }
        runtimeTargets.set(createdWorktree.id, createdTarget)
        return {
          worktree: {
            ...createdWorktree,
            parentWorktreeId: null,
            childWorktreeIds: [],
            lineage: null,
            workspaceLineage: null
          },
          lineage: null,
          warnings: []
        }
      },
      removeManagedWorktree: async (selector: string) => {
        const target = resolveTarget(selector)
        if (target.worktree.id === worktree.id) {
          throw new Error('The pipeline test runtime cannot remove its repository root')
        }
        await runGit(workspacePath, ['worktree', 'remove', '--force', target.worktree.path])
        runtimeTargets.delete(target.worktree.id)
        return {}
      },
      listRepos: () => [repo],
      listFolderWorkspaces: () =>
        workspaceKind === 'folder'
          ? [{ id: `${repoId}::${workspacePath}`, repoId, path: workspacePath }]
          : [],
      listDetectedManagedWorktrees: async () => ({ authoritative: true, worktrees: [] })
    } as unknown as OrcaRuntimeService
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the kernel notification path reads only profile/settings/repo metadata from the Store.
    const store = {
      getProfileStorageDirectory: () => profile,
      getRepo: (id: string) => (id === repoId ? repo : undefined),
      getWorktreeMetaForHost: () => null,
      getSettings: () => ({
        defaultTuiAgent: 'claude',
        disabledTuiAgents: [],
        notifications: { enabled: false }
      })
    } as unknown as Store

    return {
      root,
      profile,
      workspacePath,
      repoId,
      worktreeId,
      workspaceKind,
      runtime,
      store,
      createdWorktreePaths,
      resolveGitTarget: async (worktreeId) => resolveTarget(`id:${worktreeId}`),
      async gitWorktreePaths() {
        if (workspaceKind !== 'git') {
          return []
        }
        const listing = await runGit(workspacePath, ['worktree', 'list', '--porcelain'])
        return listing
          .split('\n')
          .filter((line) => line.startsWith('worktree '))
          .map((line) => line.slice('worktree '.length))
      }
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
