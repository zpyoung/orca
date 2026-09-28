// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ObjectiveEnrollmentSheet } from './ObjectiveEnrollmentSheet'

const { enroll } = vi.hoisted(() => ({ enroll: vi.fn() }))

vi.mock('./objective-heimdall-api', () => ({
  getObjectiveHeimdallApi: () => ({ enroll, onFleetChanged: vi.fn() }),
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

let originalState: ReturnType<typeof useAppStore.getState>
const fetchAllWorktrees = vi.fn(async () => {})

beforeEach(() => {
  originalState = useAppStore.getState()
  fetchAllWorktrees.mockReset().mockResolvedValue(undefined)
  enroll.mockReset().mockResolvedValue({})
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
})

afterEach(() => {
  cleanup()
  useAppStore.setState(originalState, true)
})

function renderSheet(): void {
  render(
    <TooltipProvider delayDuration={400}>
      <ObjectiveEnrollmentSheet open onOpenChange={vi.fn()} />
    </TooltipProvider>
  )
}

function selectNewWorktree(): void {
  fireEvent.click(screen.getByRole('combobox', { name: 'Workspace' }))
  fireEvent.click(screen.getByText('New worktree in Local'))
}

describe('new worktree objective enrollment', () => {
  it('suggests a name, preserves edits and the chosen base branch in the submission', async () => {
    renderSheet()
    selectNewWorktree()
    fireEvent.change(screen.getByRole('textbox', { name: 'Objective' }), {
      target: { value: 'Ship the objective watcher!' }
    })

    const name = screen.getByRole('textbox', { name: 'New worktree name' })
    expect(name).toHaveValue('ship-the-objective-watcher')
    fireEvent.change(name, { target: { value: 'my-worktree' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Objective' }), {
      target: { value: 'Changed objective' }
    })
    expect(name).toHaveValue('my-worktree')
    fireEvent.click(screen.getByRole('button', { name: 'Project default' }))
    expect(screen.getByRole('button', { name: 'release' })).toBeVisible()

    await waitFor(() => expect(fetchAllWorktrees).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Start objective' }))

    await waitFor(() => expect(enroll).toHaveBeenCalledTimes(1))
    expect(enroll.mock.calls[0]?.[0]).toMatchObject({
      kind: 'objective',
      repoId: 'local-repo',
      worktreeId: null,
      kindPayload: { newWorktree: { name: 'my-worktree', baseBranch: 'release' } }
    })
    await waitFor(() => expect(fetchAllWorktrees).toHaveBeenCalledTimes(2))
  })

  it('requires a nonblank edited name before sending an enrollment', () => {
    renderSheet()
    selectNewWorktree()
    fireEvent.change(screen.getByRole('textbox', { name: 'Objective' }), {
      target: { value: 'Ship it' }
    })
    fireEvent.change(screen.getByRole('textbox', { name: 'New worktree name' }), {
      target: { value: '   ' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Start objective' }))

    expect(screen.getByText('Enter a name for the new worktree.')).toBeVisible()
    expect(enroll).not.toHaveBeenCalled()
  })
})
