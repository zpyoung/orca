import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { renderNewPipeline } from '../../../shared/fork-heimdall-pipeline/yaml-writer'
import { usePipelineCanvasDraftStore } from './pipeline-canvas-draft-store'
import { openPipelineTab } from './open-pipeline-tab'

const activation = vi.hoisted(() => vi.fn())

vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: activation }))

const worktreeId = 'repo-a::/repo-a'
const worktreePath = '/repo-a'

function loadDraft(fileId: string): void {
  usePipelineCanvasDraftStore.getState().load(fileId, {
    sourceText: renderNewPipeline({
      version: 1,
      id: 'bugfix',
      name: 'Bugfix',
      inputs: { task: { type: 'text', required: true } },
      nodes: [{ id: 'agent', type: 'agent', prompt: 'repair the issue' }]
    }),
    layout: null,
    signature: { mtime: 1, sha256: 'source' },
    sourceExists: true,
    expectedId: 'bugfix',
    validationContext: { workspaceKind: 'git', expectedId: 'bugfix' }
  })
}

function seedWorkspace(): void {
  useAppStore.setState(useAppStore.getInitialState(), true)
  const repo: Repo = {
    id: 'repo-a',
    path: worktreePath,
    displayName: 'Pipeline repository',
    badgeColor: '',
    addedAt: 0,
    kind: 'git',
    executionHostId: 'local'
  }
  const worktree: Worktree = {
    id: worktreeId,
    repoId: repo.id,
    path: worktreePath,
    head: '',
    branch: 'main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'Pipeline repository',
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
  useAppStore.setState({
    activeWorktreeId: worktreeId,
    repos: [repo],
    worktreesByRepo: { [repo.id]: [worktree] }
  })
}

beforeEach(() => {
  usePipelineCanvasDraftStore.setState(usePipelineCanvasDraftStore.getInitialState(), true)
  seedWorkspace()
  activation.mockReset().mockReturnValue(true)
})

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  usePipelineCanvasDraftStore.setState(usePipelineCanvasDraftStore.getInitialState(), true)
})

describe('openPipelineTab', () => {
  it('activates the repository workspace and opens its virtual editor tab', () => {
    const fileId = openPipelineTab({ scope: 'repo', worktreeId, id: 'bugfix' })
    const file = useAppStore.getState().openFiles.find((candidate) => candidate.id === fileId)

    expect(activation).toHaveBeenCalledWith(worktreeId)
    expect(file).toMatchObject({
      filePath: `heimdall-pipeline://repo/${encodeURIComponent(worktreeId)}/bugfix`,
      relativePath: 'bugfix',
      worktreeId,
      language: 'yaml',
      mode: 'pipeline',
      pipeline: { scope: 'repo', ref: 'bugfix', worktreeId, readOnly: false }
    })
  })

  it('disposes only the draft owned by a closed tab when another owner occupies its path id', () => {
    const filePath = `heimdall-pipeline://repo/${encodeURIComponent(worktreeId)}/bugfix`
    const otherRuntimeEnvironmentId = 'runtime-owner-b'
    useAppStore.setState({
      openFiles: [
        {
          id: filePath,
          filePath,
          relativePath: 'bugfix',
          worktreeId,
          runtimeEnvironmentId: otherRuntimeEnvironmentId,
          language: 'yaml',
          isDirty: false,
          mode: 'pipeline',
          pipeline: { scope: 'repo', ref: 'bugfix', worktreeId, readOnly: false }
        } satisfies OpenFile
      ]
    })

    const ownedFileId = openPipelineTab({ scope: 'repo', worktreeId, id: 'bugfix' })
    expect(ownedFileId).not.toBe(filePath)
    if (!ownedFileId) {
      throw new Error('The pipeline tab did not open.')
    }

    loadDraft(filePath)
    loadDraft(ownedFileId)
    useAppStore.getState().closeFile(ownedFileId)

    expect(useAppStore.getState().openFiles.map((file) => file.id)).toEqual([filePath])
    expect(usePipelineCanvasDraftStore.getState().drafts[filePath]).toBeDefined()
    expect(usePipelineCanvasDraftStore.getState().drafts[ownedFileId]).toBeUndefined()
    const reopenedFileId = openPipelineTab({ scope: 'repo', worktreeId, id: 'bugfix' })
    expect(reopenedFileId).toBe(ownedFileId)
    if (!reopenedFileId) {
      throw new Error('The pipeline tab did not reopen.')
    }
    loadDraft(reopenedFileId)
    useAppStore.getState().closeFile(reopenedFileId)
    expect(usePipelineCanvasDraftStore.getState().drafts[reopenedFileId]).toBeUndefined()
  })

  it('marks a built-in editor tab read-only and does not open when workspace activation fails', () => {
    const builtInFileId = openPipelineTab({ scope: 'builtin', worktreeId, id: 'objective' })
    const builtInFile = useAppStore
      .getState()
      .openFiles.find((candidate) => candidate.id === builtInFileId)

    expect(builtInFile).toMatchObject({
      mode: 'pipeline',
      readOnly: true,
      pipeline: { scope: 'builtin', ref: 'builtin:objective', worktreeId, readOnly: true }
    })

    activation.mockReturnValue(false)
    expect(openPipelineTab({ scope: 'repo', worktreeId, id: 'other' })).toBeNull()
    expect(useAppStore.getState().openFiles.some((file) => file.pipeline?.ref === 'other')).toBe(
      false
    )
  })
})
