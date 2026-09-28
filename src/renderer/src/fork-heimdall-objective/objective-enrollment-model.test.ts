import { describe, expect, it } from 'vitest'
import { objectiveCapabilityModes } from '../../../shared/fork-heimdall-objective/contract-types'
import { defaultWatcherOwnerDraft } from '../fork-heimdall/watcher-owner-draft'
import {
  validateObjectiveEnrollmentDraft,
  type ObjectiveEnrollmentDraft,
  type ObjectiveEnrollmentGateDraft
} from './objective-enrollment-model'

function gateDraft(
  overrides: Partial<ObjectiveEnrollmentGateDraft> = {}
): ObjectiveEnrollmentGateDraft {
  return {
    rowKey: 'gate-1',
    name: 'lint',
    command: 'pnpm lint',
    timeoutSecondsText: '',
    ...overrides
  }
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
    roleLaunch: {
      planner: { model: '', effort: '' },
      implementer: { model: '', effort: '' },
      reviewer: { model: '', effort: '' },
      integrator: { model: '', effort: '' }
    },
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

const AVAILABILITY = { workspaceKind: 'git' as const, worktreeId: 'worktree' }

describe('objective enrollment gate validation', () => {
  it('accepts an empty gate list', () => {
    expect(validateObjectiveEnrollmentDraft(draft(), AVAILABILITY)).toEqual([])
  })

  it('accepts a blank timeout as valid, meaning the 1800-second default', () => {
    expect(
      validateObjectiveEnrollmentDraft(
        draft({ gates: [gateDraft({ timeoutSecondsText: '' })] }),
        AVAILABILITY
      )
    ).toEqual([])
  })

  it('rejects an invalid gate name', () => {
    expect(
      validateObjectiveEnrollmentDraft(
        draft({ gates: [gateDraft({ name: 'Lint' })] }),
        AVAILABILITY
      )
    ).toContainEqual({ code: 'gate-name-invalid', value: 'Lint' })
  })

  it('rejects an empty gate command', () => {
    expect(
      validateObjectiveEnrollmentDraft(
        draft({ gates: [gateDraft({ command: '  ' })] }),
        AVAILABILITY
      )
    ).toContainEqual({ code: 'gate-command-invalid' })
  })

  it.each(['9', '14401', '1.5', 'nope'])(
    'rejects an invalid gate timeout: %s',
    (timeoutSecondsText) => {
      expect(
        validateObjectiveEnrollmentDraft(
          draft({ gates: [gateDraft({ timeoutSecondsText })] }),
          AVAILABILITY
        )
      ).toContainEqual({ code: 'gate-timeout-invalid', value: timeoutSecondsText })
    }
  )

  it('rejects duplicate gate names', () => {
    expect(
      validateObjectiveEnrollmentDraft(
        draft({ gates: [gateDraft({ name: 'lint' }), gateDraft({ name: 'lint' })] }),
        AVAILABILITY
      )
    ).toContainEqual({ code: 'gate-name-duplicate', value: 'lint' })
  })

  it('rejects more than eight declared gates', () => {
    const gates = Array.from({ length: 9 }, (_, index) => gateDraft({ name: `gate-${index}` }))
    expect(validateObjectiveEnrollmentDraft(draft({ gates }), AVAILABILITY)).toContainEqual({
      code: 'gates-too-many'
    })
  })

  it('rejects declared gates on a parallel-unsupported host', () => {
    expect(
      validateObjectiveEnrollmentDraft(draft({ gates: [gateDraft()] }), {
        ...AVAILABILITY,
        parallelUnsupported: true
      })
    ).toContainEqual({ code: 'gates-unsupported-host' })
  })

  it('accepts an empty gate list on a parallel-unsupported host', () => {
    expect(
      validateObjectiveEnrollmentDraft(draft(), { ...AVAILABILITY, parallelUnsupported: true })
    ).toEqual([])
  })

  it('accepts a missing roleLaunch as no per-role override', () => {
    expect(
      validateObjectiveEnrollmentDraft(draft({ roleLaunch: undefined }), AVAILABILITY)
    ).toEqual([])
  })

  it('accepts a per-role model and effort override', () => {
    expect(
      validateObjectiveEnrollmentDraft(
        draft({
          roleLaunch: {
            planner: { model: 'opus', effort: 'high' },
            implementer: { model: '', effort: '' },
            reviewer: { model: '', effort: 'low' },
            integrator: { model: '', effort: '' }
          }
        }),
        AVAILABILITY
      )
    ).toEqual([])
  })
})
