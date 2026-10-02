import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runProcess } from '../../shared/child-process/run-process'
import type { Repo } from '../../shared/repo-types'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import { DESKTOP_RENDERER_CLIENT_ID } from '../runtime/rpc/methods/fork-artifact-passwords/artifact-password-local-caller'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { closeTestStores, createStore, testState } from '../persistence-test-harness'
import { bindHeimdallPipeline } from './pipeline-binding'
import type { PipelineProfileStore } from './pipeline-files'
import { createInMemoryPipelineStore } from './pipeline-store-test-fixtures'
import { ensurePipelineTrackedForWorkspace, PIPELINE_RPC_METHODS } from './pipeline-rpc-methods'

async function runGit(directory: string, args: string[]): Promise<void> {
  const result = await runProcess({ program: 'git', args, cwd: directory })
  if (result.code !== 0) {
    throw new Error(result.stderr || 'Git command failed')
  }
}

describe('pipeline RPC local-profile access', () => {
  it('refuses personal pipeline reads from paired remote clients', async () => {
    const runtime = new OrcaRuntimeService(null)
    const method = PIPELINE_RPC_METHODS[2]

    await expect(
      method.handler(
        { op: 'read', id: 'bugfix' },
        { runtime, clientKind: 'runtime', clientId: 'a'.repeat(48) }
      )
    ).rejects.toThrow('Personal pipelines are served only by the local runtime')
  })

  it('refuses personal pipeline reads from paired mobile clients', async () => {
    const runtime = new OrcaRuntimeService(null)

    await expect(
      PIPELINE_RPC_METHODS[2].handler(
        { op: 'read', id: 'bugfix' },
        { runtime, clientKind: 'mobile', clientId: 'b'.repeat(48) }
      )
    ).rejects.toThrow('Personal pipelines are served only by the local runtime')
  })

  it('serves the local profile personal list to the desktop renderer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-pipeline-personal-'))
    try {
      const runtime = new OrcaRuntimeService(null)
      testState.dir = directory
      const store = createStore()
      bindHeimdallPipeline(runtime, {
        store,
        pipelineStore: createInMemoryPipelineStore()
      })
      await mkdir(join(directory, 'pipelines'), { recursive: true })
      await writeFile(
        join(directory, 'pipelines', 'bugfix.yaml'),
        'version: 1\nid: bugfix\nname: bugfix\nnodes: []\n'
      )

      await expect(
        PIPELINE_RPC_METHODS[2].handler(
          { op: 'list' },
          { runtime, clientKind: 'runtime', clientId: DESKTOP_RENDERER_CLIENT_ID }
        )
      ).resolves.toEqual({ pipelines: [{ id: 'bugfix', name: 'bugfix' }] })
      await expect(
        PIPELINE_RPC_METHODS[2].handler({ op: 'read', id: 'bugfix' }, { runtime })
      ).resolves.toMatchObject({ yamlText: 'version: 1\nid: bugfix\nname: bugfix\nnodes: []\n' })
    } finally {
      await closeTestStores()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('re-includes an ignored repository pipeline only after explicit user intent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orca-pipeline-reinclude-'))
    try {
      await runGit(directory, ['init', '--quiet'])
      await writeFile(join(directory, '.gitignore'), '.orca/\n')
      await mkdir(join(directory, '.orca', 'pipelines'), { recursive: true })
      await writeFile(join(directory, '.orca', 'pipelines', 'bugfix.yaml'), 'version: 1\n')

      const git: GitWorktreeInfo = {
        path: directory,
        head: 'head-1',
        branch: 'main',
        isBare: false,
        isMainWorktree: true
      }
      const worktree: Worktree & { git: GitWorktreeInfo } = {
        id: `worktree:repo-1::${directory}`,
        repoId: 'repo-1',
        ...git,
        git,
        displayName: 'Repository',
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
      const repo: Repo = {
        id: 'repo-1',
        path: directory,
        displayName: 'Repository',
        badgeColor: '#777777',
        addedAt: 0,
        kind: 'git',
        executionHostId: 'local'
      }
      const target = { worktree, executionHostId: 'local' as const }
      const runtime = {
        resolveRuntimeFileTarget: async () => target,
        resolveRuntimeGitTarget: async () => ({ ...target, repo })
      }
      const store: PipelineProfileStore = {
        getProfileStorageDirectory: () => directory,
        getRepo: (repoId) => (repoId === repo.id ? repo : undefined)
      }

      const result = await ensurePipelineTrackedForWorkspace({
        runtime,
        store,
        request: {
          workspace: { repoId: repo.id, worktreeId: worktree.id },
          pipelineId: 'bugfix',
          reinclude: true
        }
      })

      expect(result).toEqual({ status: 'tracked' })
      expect(await readFile(join(directory, '.gitignore'), 'utf8')).toBe(
        '.orca/*\n!.orca/pipelines/\n'
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
