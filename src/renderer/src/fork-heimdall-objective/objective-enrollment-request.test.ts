import { describe, expect, it } from 'vitest'
import { objectiveCapabilityModes } from '../../../shared/fork-heimdall-objective/contract-types'
import { defaultWatcherOwnerDraft } from '../fork-heimdall/watcher-owner-draft'
import { buildObjectiveEnrollmentSubmission } from './objective-enrollment-request'
import type {
  ObjectiveEnrollmentDraft,
  ObjectiveEnrollmentGateDraft
} from './objective-enrollment-model'
import type { ObjectiveWorkspaceOption } from './objective-workspace-options'

function gateDraft(
  overrides: Partial<ObjectiveEnrollmentGateDraft> = {}
): ObjectiveEnrollmentGateDraft {
  return { name: 'lint', command: 'pnpm lint', timeoutSecondsText: '', ...overrides }
}

function draft(overrides: Partial<ObjectiveEnrollmentDraft> = {}): ObjectiveEnrollmentDraft {
  return {
    objectiveText: 'Ship the objective watcher',
    existingPlanText: '',
    tier: 'standard',
    landingBar: 'files-on-disk',
    maxConcurrency: 1,
    lanesEnabled: true,
    workspaceKind: 'git',
    writeTerritoryText: 'src/**',
    capabilities: objectiveCapabilityModes('files-on-disk'),
    roleAgents: { planner: '', implementer: '', reviewer: '', integrator: '' },
    sitterOverrides: {
      updateBranch: 'inherit',
      resolveConflicts: 'inherit',
      fixChecks: 'inherit',
      merge: 'inherit'
    },
    gates: [],
    activeBudgetHours: 4,
    turns: '40',
    availableAgentIds: [],
    owner: defaultWatcherOwnerDraft(),
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

describe('buildObjectiveEnrollmentSubmission gates', () => {
  it('omits gates when the draft declares none', () => {
    const submission = buildObjectiveEnrollmentSubmission(draft(), objectiveWorkspace())

    expect(submission.input.kindPayload).not.toHaveProperty('gates')
  })

  it('includes trimmed gates and the default timeout when left blank', () => {
    const submission = buildObjectiveEnrollmentSubmission(
      draft({ gates: [gateDraft({ name: ' lint ', command: ' pnpm lint ' })] }),
      objectiveWorkspace()
    )

    expect(submission.input.kindPayload).toMatchObject({
      gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 1_800 }]
    })
  })

  it('parses an explicit timeout', () => {
    const submission = buildObjectiveEnrollmentSubmission(
      draft({ gates: [gateDraft({ timeoutSecondsText: '600' })] }),
      objectiveWorkspace()
    )

    expect(submission.input.kindPayload).toMatchObject({
      gates: [{ name: 'lint', command: 'pnpm lint', timeoutSeconds: 600 }]
    })
  })

  it('strips gates for an older remote host alongside lanesEnabled', () => {
    const workspace = { ...objectiveWorkspace(), parallelExecutionSupported: false }
    const submission = buildObjectiveEnrollmentSubmission(
      draft({ gates: [gateDraft()] }),
      workspace
    )

    expect(submission.input.kindPayload).not.toHaveProperty('gates')
    expect(submission.input.kindPayload).not.toHaveProperty('lanesEnabled')
  })
})
