// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { OpenFile } from '@/store/slices/editor'
import { useAppStore } from '@/store'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { parsePipelineText } from '../../../shared/fork-heimdall-pipeline/pipeline-parse'
import { pipelineContentHash } from '../../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { sha256 } from '../../../shared/sha256'
import type { PipelineDocument } from '../../../shared/fork-heimdall-pipeline/document-schema'
import { renderNewPipeline } from '../../../shared/fork-heimdall-pipeline/yaml-writer'
import type * as PipelineFileIo from './pipeline-file-io'
import type * as OpenPipelineTabModule from './open-pipeline-tab'
import { PipelinesMenu } from './PipelinesMenu'
import type { ObjectiveWorkspaceOption } from '../fork-heimdall-objective/objective-workspace-options'
import { usePipelineCanvasDraftStore } from './pipeline-canvas-draft-store'

type RepoFile = { yamlText: string; layoutText: string }
type PersonalFile = { yamlText: string; layoutText: string | null; signature: string }

type PersonalRequest = {
  op: string
  id?: string
  yamlText?: string
  layoutText?: string | null
  expectedSignature?: string
}

function personalSignature(yamlText: string, mtime: number): string {
  const digest = [...sha256(new TextEncoder().encode(yamlText))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `${mtime}:${digest}`
}

const menuMocks = vi.hoisted(() => ({
  readRepoPipeline: vi.fn(),
  listRepoPipelineIds: vi.fn(),
  writeRepoPipeline: vi.fn(),
  deleteRepoPipeline: vi.fn(),
  openPipelineTab: vi.fn()
}))

vi.mock('./pipeline-file-io', async (importOriginal) => {
  const actual = await importOriginal<typeof PipelineFileIo>()
  return {
    ...actual,
    readRepoPipeline: menuMocks.readRepoPipeline,
    listRepoPipelineIds: menuMocks.listRepoPipelineIds,
    writeRepoPipeline: menuMocks.writeRepoPipeline,
    deleteRepoPipeline: menuMocks.deleteRepoPipeline
  }
})

vi.mock('./open-pipeline-tab', async (importOriginal) => {
  const actual = await importOriginal<typeof OpenPipelineTabModule>()
  return { ...actual, openPipelineTab: menuMocks.openPipelineTab }
})

const repoFiles = new Map<string, RepoFile>()
const personalFiles = new Map<string, PersonalFile>()
const apiMocks = {
  enroll: vi.fn(),
  pipelinePersonal: vi.fn(),
  pipelineEnsureTracked: vi.fn(),
  pipelineResolve: vi.fn(),
  pipelineList: vi.fn()
}

const worktreeId = 'repo-a::/repo-a'
const workspace: ObjectiveWorkspaceOption = {
  key: worktreeId,
  repoId: 'repo-a',
  repoPath: '/repo-a',
  worktreeId,
  workspacePath: '/repo-a',
  branch: 'main',
  workspaceKind: 'git',
  label: 'repo-a · main',
  detail: '/repo-a',
  owner: undefined,
  ownerUnavailable: false,
  availableAgentIds: ['codex']
}

function sourceDocument(): PipelineDocument {
  return {
    version: 1,
    id: 'bugfix',
    name: 'Bugfix',
    description: 'Fix and verify the deployment issue.',
    inputs: { task: { type: 'text', required: true, default: 'Repair the issue' } },
    defaults: { harness: 'codex', retry: 2 },
    nodes: [{ id: 'fix', type: 'agent', prompt: 'Fix $run.inputs.task' }]
  }
}

function seedWorkspace(): void {
  useAppStore.setState(useAppStore.getInitialState(), true)
  const repo: Repo = {
    id: 'repo-a',
    path: '/repo-a',
    displayName: 'Pipeline repository',
    badgeColor: '',
    addedAt: 0,
    kind: 'git',
    executionHostId: 'local'
  }
  const worktree: Worktree = {
    id: worktreeId,
    repoId: repo.id,
    path: '/repo-a',
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

function installApi(): void {
  const sourceText = [...repoFiles.values()][0]?.yamlText ?? renderNewPipeline(sourceDocument())
  const source = parsePipelineText(sourceText).document
  if (!source) {
    throw new Error('The repository fixture must be valid YAML.')
  }
  apiMocks.enroll.mockReset()
  apiMocks.pipelinePersonal.mockReset().mockImplementation(async (request: PersonalRequest) => {
    if (request.op === 'list') {
      return {
        pipelines: [...personalFiles].map(([id, record]) => ({
          id,
          name: parsePipelineText(record.yamlText).document?.name ?? id
        }))
      }
    }
    if (!request.id) {
      throw new Error('The personal request has no pipeline id.')
    }
    const current = personalFiles.get(request.id)
    if (request.op === 'stat') {
      return { signature: current?.signature ?? null }
    }
    if (request.op === 'read') {
      if (!current) {
        return { signature: null }
      }
      return {
        yamlText: current.yamlText,
        layoutText: current.layoutText,
        signature: current.signature
      }
    }
    if (request.op === 'write') {
      if (current && request.expectedSignature !== current.signature) {
        return { status: 'conflict', current: current.signature }
      }
      const yamlText = request.yamlText ?? ''
      const signature = personalSignature(yamlText, 20)
      personalFiles.set(request.id, {
        yamlText,
        layoutText: request.layoutText ?? null,
        signature
      })
      return { status: 'written', signature }
    }
    if (request.op === 'delete') {
      if (!current || request.expectedSignature !== current.signature) {
        return { status: 'conflict', current: current?.signature ?? null }
      }
      personalFiles.delete(request.id)
      return { status: 'deleted', current: current.signature }
    }
    throw new Error(`Unexpected personal pipeline operation: ${request.op}`)
  })
  apiMocks.pipelineList.mockReset().mockImplementation(async () => ({
    pipelines: [...repoFiles].map(([id, file]) => {
      const document = parsePipelineText(file.yamlText).document
      if (!document) {
        throw new Error('The repository fixture must be valid YAML.')
      }
      return {
        ref: id,
        scope: 'repo',
        id,
        name: document.name,
        valid: true,
        errorCount: 0,
        contentHash: pipelineContentHash(document),
        liveRuns: []
      }
    })
  }))
  apiMocks.pipelineResolve.mockReset().mockImplementation(async ({ ref }: { ref: string }) => {
    const file = repoFiles.get(ref)
    if (!file) {
      throw new Error(`Repository pipeline ${ref} is missing.`)
    }
    const document = parsePipelineText(file.yamlText).document
    if (!document) {
      throw new Error(`Repository pipeline ${ref} is invalid.`)
    }
    return {
      ref,
      scope: 'repo',
      id: ref,
      sourceText: file.yamlText,
      layoutText: file.layoutText,
      document,
      contentHash: pipelineContentHash(document),
      errors: []
    }
  })
  apiMocks.pipelineEnsureTracked
    .mockReset()
    .mockImplementation(async ({ reinclude }: { reinclude?: true }) => ({
      status: 'still-ignored',
      detail: reinclude
        ? 'A remaining ignore rule still excludes the file.'
        : 'Ignored by an outer rule.'
    }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      heimdall: {
        enroll: apiMocks.enroll,
        onFleetChanged: () => () => undefined,
        pipelineList: apiMocks.pipelineList,
        pipelineResolve: apiMocks.pipelineResolve,
        pipelinePersonal: apiMocks.pipelinePersonal,
        pipelineEnsureTracked: apiMocks.pipelineEnsureTracked
      }
    }
  })
}

function seedSources(): void {
  repoFiles.clear()
  repoFiles.set('bugfix', {
    yamlText: renderNewPipeline(sourceDocument()),
    layoutText: JSON.stringify({ version: 1, nodes: { fix: { x: 40, y: 80 } } })
  })
  personalFiles.clear()
  menuMocks.readRepoPipeline.mockReset().mockImplementation(async ({ id }: { id: string }) => {
    const file = repoFiles.get(id)
    return file
      ? {
          yamlText: file.yamlText,
          layoutText: file.layoutText,
          layout: null,
          signature: { mtime: 1, sha256: 'a'.repeat(64) }
        }
      : null
  })
  menuMocks.listRepoPipelineIds.mockReset().mockImplementation(async () => [...repoFiles.keys()])
  menuMocks.writeRepoPipeline
    .mockReset()
    .mockImplementation(
      async ({
        id,
        yamlText,
        layoutText
      }: {
        id: string
        yamlText: string
        layoutText: string
      }) => {
        repoFiles.set(id, { yamlText, layoutText })
        return { mtime: 2, sha256: 'b'.repeat(64) }
      }
    )
  menuMocks.deleteRepoPipeline.mockReset().mockImplementation(async ({ id }: { id: string }) => {
    repoFiles.delete(id)
  })
  menuMocks.openPipelineTab.mockReset().mockReturnValue('opened-pipeline-tab')
  apiMocks.pipelineEnsureTracked.mockReset()
}

function renderMenu(): void {
  render(<PipelinesMenu workspace={workspace} worktreeId={worktreeId} profileId="profile-a" />)
}
function personalCanvasTab(): OpenFile {
  const id = `heimdall-pipeline://user/${encodeURIComponent(worktreeId)}/bugfix`
  return {
    id,
    filePath: id,
    relativePath: 'bugfix',
    worktreeId,
    language: 'yaml',
    isDirty: false,
    runtimeEnvironmentId: null,
    pipeline: { scope: 'user', ref: 'user:bugfix', worktreeId, readOnly: false },
    mode: 'pipeline'
  }
}

function loadPersonalCanvasDraft(file: OpenFile): void {
  const source = personalFiles.get('bugfix')
  if (!source) {
    throw new Error('The personal pipeline fixture is missing.')
  }
  usePipelineCanvasDraftStore.getState().load(file.id, {
    sourceText: source.yamlText,
    layout: null,
    signature: null,
    sourceExists: true,
    expectedId: 'bugfix',
    validationContext: { workspaceKind: 'git', expectedId: 'bugfix' }
  })
}

function personalCopyOption(): HTMLElement {
  const option = screen
    .getAllByRole('menuitem')
    .find((item) => item.textContent?.includes('bugfix') && item.textContent.includes('Personal'))
  if (!option) {
    throw new Error('The personal Bugfix pipeline is not listed.')
  }
  return option
}

afterEach(() => {
  cleanup()
  usePipelineCanvasDraftStore.setState(usePipelineCanvasDraftStore.getInitialState(), true)
  useAppStore.setState(useAppStore.getInitialState(), true)
})

beforeEach(() => {
  usePipelineCanvasDraftStore.setState(usePipelineCanvasDraftStore.getInitialState(), true)
  seedWorkspace()
  seedSources()
  installApi()
})

describe('PipelinesMenu scope actions', () => {
  it('copies a repository definition to the first available personal id without writing into the repository', async () => {
    const user = userEvent.setup()
    for (const id of ['bugfix', 'bugfix-2']) {
      const personalDocument = { ...sourceDocument(), id, name: `Personal ${id}` }
      const yamlText = renderNewPipeline(personalDocument)
      personalFiles.set(id, {
        yamlText,
        layoutText: null,
        signature: personalSignature(yamlText, id === 'bugfix' ? 10 : 11)
      })
    }
    installApi()
    renderMenu()
    await user.click(screen.getByRole('button', { name: 'Pipelines' }))
    await screen.findByRole('menuitem', { name: 'Copy to my pipelines' })
    const repoPipeline = await screen.findByRole('menuitem', { name: 'Bugfix' })
    await user.click(repoPipeline)

    await user.click(screen.getByRole('menuitem', { name: 'Copy to my pipelines' }))

    await waitFor(() => expect(personalFiles.has('bugfix-3')).toBe(true))
    const original = parsePipelineText(repoFiles.get('bugfix')?.yamlText ?? '').document
    const copied = parsePipelineText(personalFiles.get('bugfix-3')?.yamlText ?? '').document
    if (!original || !copied) {
      throw new Error('The copied pipeline must stay parseable.')
    }
    const { id: originalId, name: originalName, ...originalContent } = original
    const { id, name, ...copiedContent } = copied
    expect({ originalId, id }).toEqual({ originalId: 'bugfix', id: 'bugfix-3' })
    expect(name).not.toBe(originalName)
    expect(copiedContent).toEqual(originalContent)
    expect(repoFiles.size).toBe(1)
  })

  it('deletes the selected personal copy and closes its clean canvas tab', async () => {
    const user = userEvent.setup()
    const yamlText = renderNewPipeline({ ...sourceDocument(), name: 'Personal bugfix' })
    const signature = personalSignature(yamlText, 30)
    personalFiles.set('bugfix', { yamlText, layoutText: null, signature })
    const canvasTab = personalCanvasTab()
    useAppStore.setState({ openFiles: [canvasTab] })
    loadPersonalCanvasDraft(canvasTab)
    installApi()
    renderMenu()
    await user.click(screen.getByRole('button', { name: 'Pipelines' }))
    await screen.findByRole('menuitem', { name: 'Copy to my pipelines' })

    await user.click(personalCopyOption())
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('My pipelines')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(personalFiles.has('bugfix')).toBe(false))
    expect(repoFiles.has('bugfix')).toBe(true)
    expect(useAppStore.getState().openFiles.some((file) => file.id === canvasTab.id)).toBe(false)
    expect(usePipelineCanvasDraftStore.getState().drafts[canvasTab.id]).toBeUndefined()
  })

  it('refuses deletion while the selected personal canvas has unsaved draft edits', async () => {
    const user = userEvent.setup()
    const yamlText = renderNewPipeline({ ...sourceDocument(), name: 'Personal bugfix' })
    personalFiles.set('bugfix', {
      yamlText,
      layoutText: null,
      signature: personalSignature(yamlText, 30)
    })
    const canvasTab = personalCanvasTab()
    useAppStore.setState({ openFiles: [canvasTab] })
    loadPersonalCanvasDraft(canvasTab)
    usePipelineCanvasDraftStore
      .getState()
      .editDocument(canvasTab.id, (document) => ({ ...document, name: 'Unsaved edit' }))
    installApi()
    renderMenu()
    await user.click(screen.getByRole('button', { name: 'Pipelines' }))
    await screen.findByRole('menuitem', { name: 'Copy to my pipelines' })

    await user.click(personalCopyOption())
    await user.click(screen.getByRole('menuitem', { name: 'Delete' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }))

    expect(within(dialog).getByRole('alert')).toBeInTheDocument()
    expect(personalFiles.has('bugfix')).toBe(true)
    expect(usePipelineCanvasDraftStore.getState().drafts[canvasTab.id]?.dirty).toBe(true)
  })

  it('keeps a still-ignored repo copy visible and re-includes only after the notice action', async () => {
    const user = userEvent.setup()
    renderMenu()
    await user.click(screen.getByRole('button', { name: 'Pipelines' }))
    await screen.findByRole('menuitem', { name: 'Copy to my pipelines' })

    const repoPipeline = await screen.findByRole('menuitem', { name: 'Bugfix' })
    await user.click(repoPipeline)
    await user.click(screen.getByRole('menuitem', { name: 'Copy to repo' }))

    await screen.findByRole('status')
    expect(repoFiles.has('bugfix-2')).toBe(true)
    expect(screen.getByRole('button', { name: 'Re-include pipelines' })).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Re-include pipelines' }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Re-include pipelines' })).not.toBeInTheDocument()
    )
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})
