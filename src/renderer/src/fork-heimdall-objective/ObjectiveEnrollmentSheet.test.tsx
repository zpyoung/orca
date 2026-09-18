// @vitest-environment happy-dom

import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getDefaultSettings } from '../../../shared/constants'
import {
  OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB,
  OBJECTIVE_EXISTING_PLAN_MAX_LENGTH,
  objectiveCapabilityModes
} from '../../../shared/fork-heimdall-objective/contract-types'
import { ObjectiveEnrollmentFields } from './ObjectiveEnrollmentFields'
import { buildObjectiveEnrollmentSubmission } from './objective-enrollment-request'
import {
  isObjectiveLandingBarAvailable,
  validateObjectiveEnrollmentDraft,
  type ObjectiveEnrollmentDraft,
  type ObjectiveLandingBarAvailability
} from './objective-enrollment-model'
import {
  buildObjectiveWorkspaceOptions,
  type ObjectiveWorkspaceOption
} from './objective-workspace-options'

afterEach(cleanup)

function draft(overrides: Partial<ObjectiveEnrollmentDraft> = {}): ObjectiveEnrollmentDraft {
  return {
    objectiveText: 'Ship the objective watcher',
    existingPlanText: '',
    tier: 'standard',
    landingBar: 'files-on-disk',
    maxConcurrency: 1,
    workspaceKind: 'git',
    writeTerritoryText: 'src/**\ntests/**',
    capabilities: objectiveCapabilityModes('files-on-disk'),
    roleAgents: { planner: '', implementer: '', reviewer: '', integrator: '' },
    sitterOverrides: {
      updateBranch: 'inherit',
      resolveConflicts: 'inherit',
      fixChecks: 'inherit',
      merge: 'inherit'
    },
    activeBudgetHours: 4,
    turns: '40',
    availableAgentIds: ['codex'],
    ...overrides
  }
}

function objectiveWorkspace(): ObjectiveWorkspaceOption {
  return {
    key: 'runtime:hermes:repo:worktree',
    repoId: 'repo',
    repoPath: '/workspace/repo',
    worktreeId: 'worktree',
    workspacePath: '/workspace/repo',
    branch: 'main',
    workspaceKind: 'git',
    label: 'Workspace',
    detail: '/workspace',
    owner: { connectionId: 'hermes', pairingRevision: 22 },
    ownerUnavailable: false,
    availableAgentIds: ['codex']
  }
}

function EditableObjectiveFields({
  existingPlanText = ''
}: {
  existingPlanText?: string
}): React.JSX.Element {
  const [currentDraft, setCurrentDraft] = useState(() =>
    draft({ objectiveText: '', existingPlanText })
  )
  return (
    <TooltipProvider delayDuration={400}>
      <ObjectiveEnrollmentFields
        draft={currentDraft}
        selectedWorkspaceKey=""
        workspaces={[]}
        landingAvailability={{ workspaceKind: null, worktreeId: null }}
        agents={[]}
        disabled={false}
        onWorkspaceChange={() => {}}
        onDraftChange={setCurrentDraft}
      />
    </TooltipProvider>
  )
}

function deferredPlanFile(): { file: File; resolve: (contents: string) => void } {
  let resolve!: (contents: string) => void
  const contents = new Promise<string>((settle) => {
    resolve = settle
  })
  const file = new File([], 'deferred.md', { type: 'text/markdown' })
  Object.defineProperty(file, 'text', { value: () => contents })
  return { file, resolve }
}

function runtimeState(): Pick<
  AppState,
  | 'repos'
  | 'worktreesByRepo'
  | 'runtimeEnvironments'
  | 'detectedAgentIds'
  | 'remoteDetectedAgentIds'
  | 'runtimeDetectedAgentIds'
  | 'settings'
> {
  return {
    repos: [
      {
        id: 'git-repo',
        path: '/workspace/git',
        displayName: 'Git project',
        badgeColor: 'gray',
        addedAt: 1,
        kind: 'git',
        executionHostId: 'runtime:hermes'
      },
      {
        id: 'folder-repo',
        path: '/workspace/folder',
        displayName: 'Folder project',
        badgeColor: 'gray',
        addedAt: 1,
        kind: 'folder',
        executionHostId: 'runtime:hermes'
      }
    ],
    worktreesByRepo: {
      'git-repo': [
        {
          id: 'git-repo::/workspace/git',
          repoId: 'git-repo',
          path: '/workspace/git',
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
          lastActivityAt: 1,
          hostId: 'runtime:hermes'
        }
      ]
    },
    runtimeEnvironments: [
      {
        id: 'hermes',
        name: 'Hermes',
        createdAt: 10,
        updatedAt: 20,
        pairingRevision: 22,
        lastUsedAt: null,
        runtimeId: 'runtime-hermes',
        endpoints: [],
        preferredEndpointId: 'ws-hermes'
      }
    ],
    detectedAgentIds: ['claude'],
    remoteDetectedAgentIds: {},
    runtimeDetectedAgentIds: { hermes: ['codex'] },
    settings: { ...getDefaultSettings('/tmp'), disabledTuiAgents: [] }
  }
}

describe('objective enrollment contract', () => {
  it('lets the user enter objective text into the controlled field', () => {
    render(<EditableObjectiveFields />)

    const objective = screen.getByRole('textbox', { name: 'Objective' })
    fireEvent.change(objective, { target: { value: 'Ship the visible objective' } })

    expect((objective as HTMLTextAreaElement).value).toBe('Ship the visible objective')
  })

  it('keeps the prior source plan when an imported file exceeds the pre-read size limit', () => {
    const priorPlan = '# Existing plan'
    const { container } = render(<EditableObjectiveFields existingPlanText={priorPlan} />)
    const source = screen.getByRole('textbox', { name: 'Existing plan source' })
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')
    const oversizedFile = new File(
      [new Uint8Array(OBJECTIVE_EXISTING_PLAN_MAX_LENGTH * 4 + 1)],
      'oversized.md',
      { type: 'text/markdown' }
    )

    expect(fileInput).not.toBeNull()
    fireEvent.change(fileInput!, { target: { files: [oversizedFile] } })

    expect((source as HTMLTextAreaElement).value).toBe(priorPlan)
    expect(source.getAttribute('aria-invalid')).toBe('true')
  })

  it('keeps concurrent draft edits and cancels a pending import when the plan is removed', async () => {
    const { container } = render(<EditableObjectiveFields existingPlanText="# Existing plan" />)
    const objective = screen.getByRole('textbox', { name: 'Objective' })
    const fileInput = container.querySelector<HTMLInputElement>('input[type="file"]')
    const firstImport = deferredPlanFile()

    expect(fileInput).not.toBeNull()
    fireEvent.change(fileInput!, { target: { files: [firstImport.file] } })
    fireEvent.change(objective, { target: { value: 'Latest objective text' } })
    await act(async () => {
      firstImport.resolve('# Imported plan')
      await Promise.resolve()
    })

    expect((objective as HTMLTextAreaElement).value).toBe('Latest objective text')
    expect(
      (screen.getByRole('textbox', { name: 'Existing plan source' }) as HTMLTextAreaElement).value
    ).toBe('# Imported plan')

    const staleImport = deferredPlanFile()
    fireEvent.change(fileInput!, { target: { files: [staleImport.file] } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove plan' }))
    await act(async () => {
      staleImport.resolve('# Stale plan')
      await Promise.resolve()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add existing plan' }))

    expect(
      (screen.getByRole('textbox', { name: 'Existing plan source' }) as HTMLTextAreaElement).value
    ).toBe('')
  })

  it('rejects source plans only after the shared character limit', () => {
    const availability: ObjectiveLandingBarAvailability = {
      workspaceKind: 'git',
      worktreeId: 'worktree'
    }

    expect(
      validateObjectiveEnrollmentDraft(
        draft({ existingPlanText: 'x'.repeat(OBJECTIVE_EXISTING_PLAN_MAX_LENGTH) }),
        availability
      ).some((error) => error.code === 'existing-plan-too-long')
    ).toBe(false)
    expect(
      validateObjectiveEnrollmentDraft(
        draft({ existingPlanText: 'x'.repeat(OBJECTIVE_EXISTING_PLAN_MAX_LENGTH + 1) }),
        availability
      ).some((error) => error.code === 'existing-plan-too-long')
    ).toBe(true)
  })
  it('blocks plan-off when the form cannot establish a reusable approved plan', () => {
    const capabilities = objectiveCapabilityModes('files-on-disk')
    expect(
      validateObjectiveEnrollmentDraft(
        draft({
          capabilities: { ...capabilities, plan: 'off' },
          existingPlanText: '# Planner source is not an approved plan'
        }),
        { workspaceKind: 'git', worktreeId: 'worktree' }
      )
    ).toContainEqual({ code: 'plan-off-requires-approved-plan' })
  })

  it('prevalidates the owner rules the RPC cannot describe', () => {
    const errors = validateObjectiveEnrollmentDraft(
      draft({
        workspaceKind: 'folder',
        landingBar: 'merged',
        maxConcurrency: 2,
        writeTerritoryText: '.g*/**\nsrc/**\nsrc/**',
        roleAgents: { planner: 'claude', implementer: '', reviewer: '', integrator: '' }
      }),
      { workspaceKind: 'folder', worktreeId: null }
    )

    expect(errors.map((error) => error.code)).toEqual([
      'landing-bar-requires-git',
      'max-concurrency-unsupported',
      'territory-duplicate',
      'territory-invalid',
      'role-agent-unknown'
    ])
  })

  it('treats blank territory as the whole workspace when validating and serializing', () => {
    const blankTerritoryDraft = draft({ writeTerritoryText: ' \n\t' })

    expect(
      validateObjectiveEnrollmentDraft(blankTerritoryDraft, {
        workspaceKind: 'git',
        worktreeId: 'worktree'
      })
    ).toEqual([])
    expect(
      buildObjectiveEnrollmentSubmission(blankTerritoryDraft, objectiveWorkspace()).input
    ).toMatchObject({
      kindPayload: { writeTerritory: [OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB] }
    })
  })

  it('offers hosted landing bars immediately for a selected git worktree', () => {
    const folder: ObjectiveLandingBarAvailability = {
      workspaceKind: 'folder',
      worktreeId: null
    }
    const missingWorktree: ObjectiveLandingBarAvailability = {
      workspaceKind: 'git',
      worktreeId: null
    }
    const gitWorktree: ObjectiveLandingBarAvailability = {
      workspaceKind: 'git',
      worktreeId: 'worktree'
    }

    expect(isObjectiveLandingBarAvailable(folder, 'files-on-disk')).toBe(true)
    expect(isObjectiveLandingBarAvailable(folder, 'committed-local-branch')).toBe(false)
    expect(isObjectiveLandingBarAvailable(folder, 'pushed-ref')).toBe(false)
    expect(isObjectiveLandingBarAvailable(missingWorktree, 'hosted-review')).toBe(false)
    expect(isObjectiveLandingBarAvailable(gitWorktree, 'hosted-review')).toBe(true)
    expect(isObjectiveLandingBarAvailable(gitWorktree, 'merged')).toBe(true)
    expect(validateObjectiveEnrollmentDraft(draft({ landingBar: 'merged' }), gitWorktree)).toEqual(
      []
    )
  })

  it('routes both git and folder selections to their actual runtime owner', () => {
    const options = buildObjectiveWorkspaceOptions(runtimeState())
    const git = options.find((option) => option.workspaceKind === 'git')
    const folder = options.find((option) => option.workspaceKind === 'folder')

    expect(git).toMatchObject({
      repoId: 'git-repo',
      worktreeId: 'git-repo::/workspace/git',
      owner: { connectionId: 'hermes', pairingRevision: 22 },
      availableAgentIds: ['codex']
    })
    expect(folder).toMatchObject({
      repoId: 'folder-repo',
      worktreeId: null,
      owner: { connectionId: 'hermes', pairingRevision: 22 },
      availableAgentIds: ['codex']
    })
  })

  it('builds the exact enrollment payload and passes the selected owner fence', () => {
    const workspace = objectiveWorkspace()
    const submission = buildObjectiveEnrollmentSubmission(
      draft({
        objectiveText: '  Ship it  ',
        existingPlanText: '  # Supplied plan\n\nShip task A.  ',
        roleAgents: { planner: 'codex', implementer: '', reviewer: '', integrator: '' },
        sitterOverrides: {
          updateBranch: 'gated',
          resolveConflicts: 'inherit',
          fixChecks: 'inherit',
          merge: 'off'
        }
      }),
      workspace
    )

    expect(submission.owner).toEqual({ connectionId: 'hermes', pairingRevision: 22 })
    expect(submission.input).toMatchObject({
      kind: 'objective',
      repoId: 'repo',
      worktreeId: 'worktree',
      budget: { wallClockActiveMs: 14_400_000, turns: 40 },
      kindPayload: {
        objectiveText: 'Ship it',
        maxConcurrency: 1,
        existingPlan: '# Supplied plan\n\nShip task A.',
        workspaceKind: 'git',
        writeTerritory: ['src/**', 'tests/**'],
        roleAgents: { planner: 'codex' },
        sitterOverrides: { updateBranch: 'gated', merge: 'off' }
      }
    })
    expect(
      buildObjectiveEnrollmentSubmission(draft({ existingPlanText: ' \n\t' }), objectiveWorkspace())
        .input.kindPayload
    ).not.toHaveProperty('existingPlan')
  })
})
