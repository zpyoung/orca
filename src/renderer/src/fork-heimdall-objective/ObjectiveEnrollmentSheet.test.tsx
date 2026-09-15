// @vitest-environment happy-dom

import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { getDefaultSettings } from '../../../shared/constants'
import { objectiveCapabilityModes } from '../../../shared/fork-heimdall-objective/contract-types'
import { ObjectiveEnrollmentFields } from './ObjectiveEnrollmentFields'
import { buildObjectiveEnrollmentSubmission } from './objective-enrollment-request'
import {
  isObjectiveLandingBarAvailable,
  validateObjectiveEnrollmentDraft,
  type ObjectiveEnrollmentDraft
} from './objective-enrollment-model'
import {
  buildObjectiveWorkspaceOptions,
  type ObjectiveWorkspaceOption
} from './objective-workspace-options'

afterEach(cleanup)

function draft(overrides: Partial<ObjectiveEnrollmentDraft> = {}): ObjectiveEnrollmentDraft {
  return {
    objectiveText: 'Ship the objective watcher',
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

function EditableObjectiveFields(): React.JSX.Element {
  const [currentDraft, setCurrentDraft] = useState(() => draft({ objectiveText: '' }))
  return (
    <ObjectiveEnrollmentFields
      draft={currentDraft}
      selectedWorkspaceKey=""
      workspaces={[]}
      agents={[]}
      disabled={false}
      onWorkspaceChange={() => {}}
      onDraftChange={setCurrentDraft}
    />
  )
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

  it('prevalidates the owner rules the RPC cannot describe', () => {
    const errors = validateObjectiveEnrollmentDraft(
      draft({
        workspaceKind: 'folder',
        landingBar: 'merged',
        maxConcurrency: 2,
        writeTerritoryText: '.g*/**\nsrc/**\nsrc/**',
        roleAgents: { planner: 'claude', implementer: '', reviewer: '', integrator: '' }
      })
    )

    expect(errors.map((error) => error.code)).toEqual([
      'landing-bar-requires-git',
      'max-concurrency-unsupported',
      'territory-duplicate',
      'territory-invalid',
      'role-agent-unknown'
    ])
  })

  it('only offers the files-on-disk landing bar for folder workspaces', () => {
    expect(isObjectiveLandingBarAvailable('folder', 'files-on-disk')).toBe(true)
    expect(isObjectiveLandingBarAvailable('folder', 'committed-local-branch')).toBe(false)
    expect(isObjectiveLandingBarAvailable('folder', 'pushed-ref')).toBe(false)
    expect(isObjectiveLandingBarAvailable('git', 'merged')).toBe(true)
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
    const workspace: ObjectiveWorkspaceOption = {
      key: 'runtime:hermes:repo:worktree',
      repoId: 'repo',
      worktreeId: 'worktree',
      workspaceKind: 'git',
      label: 'Workspace',
      detail: '/workspace',
      owner: { connectionId: 'hermes', pairingRevision: 22 },
      ownerUnavailable: false,
      availableAgentIds: ['codex']
    }
    const submission = buildObjectiveEnrollmentSubmission(
      draft({
        objectiveText: '  Ship it  ',
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
        workspaceKind: 'git',
        writeTerritory: ['src/**', 'tests/**'],
        roleAgents: { planner: 'codex' },
        sitterOverrides: { updateBranch: 'gated', merge: 'off' }
      }
    })
  })
})
