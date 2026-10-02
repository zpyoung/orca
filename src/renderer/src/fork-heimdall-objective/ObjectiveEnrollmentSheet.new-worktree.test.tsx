// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { builtinPipelinePin } from '../../../shared/fork-heimdall-pipeline/builtin-pipelines'
import type { Worktree } from '../../../shared/worktree/types'
import { setLocalRuntimeCapabilitiesForTests } from '../runtime/local-runtime-capabilities'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ObjectiveEnrollmentSheet } from './ObjectiveEnrollmentSheet'

const { enroll, pipelineList, pipelinePersonal } = vi.hoisted(() => ({
  enroll: vi.fn(),
  pipelineList: vi.fn(),
  pipelinePersonal: vi.fn()
}))

vi.mock('./objective-heimdall-api', () => ({
  getObjectiveHeimdallApi: () => ({
    enroll,
    pipelineList,
    pipelinePersonal,
    onFleetChanged: vi.fn()
  }),
  describeObjectiveError: (error: unknown) => String(error)
}))

vi.mock('@/components/repo/CreateFromPicker', () => ({
  CreateFromPicker: ({
    value,
    onValueChange
  }: {
    value: string
    onValueChange: (value: string) => void
  }) => (
    <button type="button" onClick={() => onValueChange(value ? '' : 'release')}>
      {value || 'Project default'}
    </button>
  )
}))

const repo = {
  id: 'local-repo',
  path: '/repos/local',
  displayName: 'Local',
  badgeColor: 'gray',
  addedAt: 1,
  kind: 'git' as const
}

const worktree: Worktree = {
  id: 'local-repo::/repos/local',
  repoId: 'local-repo',
  path: '/repos/local',
  head: 'abc',
  branch: 'main',
  isBare: false,
  isMainWorktree: true,
  displayName: 'main',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}

let originalState: AppState

function builtinChoice(id: 'objective' | 'pr-sitter', name: string) {
  const pin = builtinPipelinePin(id)
  return {
    ref: pin.ref,
    scope: pin.scope,
    id: pin.id,
    name,
    valid: true,
    errorCount: 0,
    contentHash: pin.contentHash,
    liveRuns: []
  }
}
const fetchAllWorktrees = vi.fn(async () => {})

beforeEach(() => {
  originalState = useAppStore.getState()
  fetchAllWorktrees.mockReset().mockResolvedValue(undefined)
  enroll.mockReset().mockResolvedValue({})
  pipelineList.mockReset().mockResolvedValue({
    pipelines: [builtinChoice('objective', 'Objective'), builtinChoice('pr-sitter', 'PR sitter')]
  })
  pipelinePersonal.mockReset().mockImplementation(async ({ op }: { op: string }) => {
    if (op !== 'list') {
      throw new Error(`Unexpected personal pipeline operation: ${op}`)
    }
    return { pipelines: [] }
  })
  useAppStore.setState({
    repos: [repo],
    worktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    runtimeEnvironments: [],
    detectedAgentIds: ['claude'],
    remoteDetectedAgentIds: {},
    runtimeDetectedAgentIds: {},
    runtimeStatusByEnvironmentId: new Map(),
    fetchAllWorktrees,
    hydrateHeimdallFleet: vi.fn(async () => {})
  })
  setLocalRuntimeCapabilitiesForTests([])
})

afterEach(() => {
  cleanup()
  useAppStore.setState(originalState, true)
  setLocalRuntimeCapabilitiesForTests(null)
})

function renderSheet(): void {
  render(
    <TooltipProvider delayDuration={400}>
      <ObjectiveEnrollmentSheet open onOpenChange={vi.fn()} />
    </TooltipProvider>
  )
}

async function selectNewWorktree(): Promise<void> {
  fireEvent.click(await screen.findByRole('combobox', { name: 'Workspace' }))
  fireEvent.click(await screen.findByText('New worktree in Local'))
}

describe('new worktree objective enrollment', () => {
  it('suggests a name, preserves edits and the chosen base branch in the submission', async () => {
    renderSheet()
    await selectNewWorktree()
    fireEvent.change(await screen.findByRole('textbox', { name: 'Objective' }), {
      target: { value: 'Ship the objective watcher!' }
    })

    const name = screen.getByRole('textbox', { name: 'New worktree name' })
    expect(name).toHaveValue('ship-the-objective-watcher')
    fireEvent.change(name, { target: { value: 'my-worktree' } })
    fireEvent.change(await screen.findByRole('textbox', { name: 'Objective' }), {
      target: { value: 'Changed objective' }
    })
    expect(name).toHaveValue('my-worktree')
    fireEvent.click(await screen.findByRole('button', { name: 'Project default' }))
    expect(await screen.findByRole('button', { name: 'release' })).toBeVisible()

    fireEvent.click(screen.getByRole('button', { name: 'Start run' }))

    await waitFor(() => expect(enroll).toHaveBeenCalledTimes(1))
    expect(enroll.mock.calls[0]?.[0]).toMatchObject({
      kind: 'objective',
      repoId: 'local-repo',
      worktreeId: null,
      kindPayload: { newWorktree: { name: 'my-worktree', baseBranch: 'release' } }
    })
  })

  it('drops a chosen base branch when the new worktree moves to another repository', async () => {
    useAppStore.setState({
      repos: [repo, { ...repo, id: 'other-repo', path: '/repos/other', displayName: 'Other' }]
    })
    renderSheet()
    await selectNewWorktree()
    fireEvent.click(await screen.findByRole('button', { name: 'Project default' }))
    expect(await screen.findByRole('button', { name: 'release' })).toBeVisible()

    fireEvent.click(screen.getByRole('combobox', { name: 'Workspace' }))
    fireEvent.click(await screen.findByText('New worktree in Other'))
    expect(await screen.findByRole('button', { name: 'Project default' })).toBeVisible()

    fireEvent.change(await screen.findByRole('textbox', { name: 'Objective' }), {
      target: { value: 'Ship it' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }))
    await waitFor(() => expect(enroll).toHaveBeenCalledTimes(1))
    expect(enroll.mock.calls[0]?.[0]).toMatchObject({
      repoId: 'other-repo',
      kindPayload: { newWorktree: { name: 'ship-it' } }
    })
    expect(enroll.mock.calls[0]?.[0].kindPayload.newWorktree).not.toHaveProperty('baseBranch')
  })

  it('requires a nonblank edited name before sending an enrollment', async () => {
    renderSheet()
    await selectNewWorktree()
    fireEvent.change(await screen.findByRole('textbox', { name: 'Objective' }), {
      target: { value: 'Ship it' }
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'New worktree name' }), {
      target: { value: '   ' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }))

    expect(screen.getByText('Enter a name for the new worktree.')).toBeVisible()
    expect(enroll).not.toHaveBeenCalled()
  })

  it('preselects the built-in Objective pipeline and keeps its native enrollment payload', async () => {
    useAppStore.setState({
      activeWorktreeId: worktree.id,
      worktreesByRepo: { [repo.id]: [worktree] }
    })
    renderSheet()

    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Pipeline' })).toHaveTextContent('Objective')
    )
    const objective = await screen.findByRole('textbox', { name: 'Objective' })
    fireEvent.change(objective, { target: { value: 'Ship the release fix' } })
    expect(screen.getByRole('button', { name: 'Start run' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Start run' }))

    await waitFor(() => expect(enroll).toHaveBeenCalledTimes(1))
    expect(enroll).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'objective',
        repoId: repo.id,
        worktreeId: worktree.id,
        kindPayload: expect.objectContaining({
          objectiveText: 'Ship the release fix',
          workspaceKind: 'git'
        })
      }),
      undefined
    )
    const submitted = enroll.mock.calls[0]?.[0]
    expect(submitted).not.toHaveProperty('pipelinePin')
    expect(submitted).not.toHaveProperty('pipelineSource')
  })
})
