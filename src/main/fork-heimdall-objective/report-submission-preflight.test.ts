import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SubmissionPreflightResult } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { attempt, CONTRACT } from '../../shared/fork-heimdall-objective/decision-test-harness'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import { OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH } from '../../shared/fork-heimdall-objective/contract-types'
import type { ObjectivePlanTask } from '../../shared/fork-heimdall-objective/plan-schema'
import type { IFilesystemProvider } from '../providers/types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import type { ObjectiveStore } from './objective-store'
import { createObjectiveSubmissionAdapter } from './report-submission-preflight'
import { issueObjectiveReportPath, resolveExpectedObjectiveReportPath } from './report-ingestion'

const { resolveWorkspaceTarget, validateWorkspaceChanges } = vi.hoisted(() => ({
  resolveWorkspaceTarget: vi.fn(),
  validateWorkspaceChanges: vi.fn()
}))

vi.mock('./workspace-target', () => ({
  resolveObjectiveWorkspaceTarget: resolveWorkspaceTarget
}))
vi.mock('./observed-workspace-changes', () => ({
  validateObjectiveWorkspaceChanges: validateWorkspaceChanges
}))

const DISPATCH_ID = 'dispatch-core'
const ACTION: ObjectiveAction = {
  kind: 'dispatch-node',
  capability: 'implement',
  visibility: 'local',
  contentIdentity: 'content-current',
  evidenceKey: 'revision-1:core',
  revisionId: 'revision-1',
  taskKey: 'core',
  depsOrchestrationIds: []
}
const TASK: ObjectivePlanTask = {
  taskKey: 'core',
  title: 'Core',
  spec: 'Implement core',
  deps: [],
  criteria: [
    { body: 'First criterion', shellCheckable: false, checkCommand: null },
    { body: 'Second criterion', shellCheckable: false, checkCommand: null }
  ],
  declaresDependencyChange: false
}
const ENROLLMENT = {
  kind: 'objective',
  kindPayload: CONTRACT
} as unknown as WatcherEnrollment
const LEDGER = {
  watcherId: 'watcher-1',
  entries: [attempt(ACTION, { dispatchId: DISPATCH_ID })]
}
const OBJECTIVE_STORE = {
  getPlan: () => [TASK],
  getTask: () => TASK,
  getDispatch: () => null
} as unknown as ObjectiveStore

function expectActionableRejection(
  result: SubmissionPreflightResult,
  expectedDetail: string
): void {
  expect(result).toMatchObject({ status: 'rejected', code: 'heimdall_report_invalid' })
  if (result.status !== 'rejected') {
    throw new Error('expected report rejection')
  }
  expect(result.reason).toContain(expectedDetail)
  expect(result.reason).toContain('Correct the issued report file')
  expect(result.reason).toContain('resend the same worker_done command')
  expect(result.reason).toContain('Dispatch is still active')
}

describe('objective report submission preflight', () => {
  let workspacePath: string
  let target: ObjectiveWorkspaceTarget
  let reportPath: string

  beforeEach(async () => {
    workspacePath = await mkdtemp(join(tmpdir(), 'orca-objective-preflight-'))
    target = {
      kind: 'folder',
      executionHostId: 'local',
      workspacePath,
      fileProvider: null
    }
    resolveWorkspaceTarget.mockReset()
    validateWorkspaceChanges.mockReset()
    resolveWorkspaceTarget.mockResolvedValue(target)
    validateWorkspaceChanges.mockResolvedValue({ ok: true, changedPaths: ['src/core.ts'] })
    reportPath = await issueObjectiveReportPath(target, `fingerprint-${DISPATCH_ID}`)
  })

  afterEach(async () => {
    await rm(workspacePath, { recursive: true, force: true })
  })

  it('rejects actionable report defects and accepts the corrected same submission', async () => {
    const adapter = createObjectiveSubmissionAdapter({
      runtime: {} as OrcaRuntimeService,
      objectiveStore: OBJECTIVE_STORE
    })
    const submission = {
      dispatchId: DISPATCH_ID,
      payload: { reportPath, filesModified: ['src/core.ts'] }
    } as const
    const context = { enrollment: ENROLLMENT, snapshot: null, ledger: LEDGER }

    await writeFile(
      reportPath,
      JSON.stringify({
        taskKey: 'core',
        summary: 's'.repeat(OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH + 1),
        filesModified: ['src/core.ts'],
        criteriaSelfAssessment: [
          { criterionIndex: 0, result: 'pass', note: 'Verified' },
          { criterionIndex: 1, result: 'pass', note: 'Verified' }
        ]
      })
    )
    expectActionableRejection(await adapter.preflightWorkerReport(submission, context), 'summary')

    await writeFile(reportPath, '{not-json')
    expectActionableRejection(
      await adapter.preflightWorkerReport(submission, context),
      'malformed JSON or schema violation'
    )

    await writeFile(
      reportPath,
      JSON.stringify({
        taskKey: 'core',
        summary: 'Implemented core',
        filesModified: ['src/core.ts'],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified' }]
      })
    )
    expectActionableRejection(
      await adapter.preflightWorkerReport(submission, context),
      'must assess every criterion'
    )

    await writeFile(
      reportPath,
      JSON.stringify({
        taskKey: 'core',
        summary: 'Implemented core',
        filesModified: ['src/core.ts'],
        criteriaSelfAssessment: [
          { criterionIndex: 0, result: 'pass', note: 'Verified' },
          { criterionIndex: 1, result: 'pass', note: 'Verified' }
        ]
      })
    )
    await expect(adapter.preflightWorkerReport(submission, context)).resolves.toEqual({
      status: 'accepted'
    })
  })

  it('accepts an unverifiable host read instead of mislabeling it as invalid input', async () => {
    const hostFailure = new Error('remote host unavailable')
    const fileProvider = {
      realpath: vi.fn().mockRejectedValue(hostFailure),
      lstat: vi.fn(),
      readFile: vi.fn()
    } as unknown as IFilesystemProvider
    const remoteTarget = {
      kind: 'folder',
      executionHostId: 'ssh:host-1',
      workspacePath: '/workspace',
      fileProvider
    } as ObjectiveWorkspaceTarget
    resolveWorkspaceTarget.mockResolvedValue(remoteTarget)
    const remoteReportPath = await resolveExpectedObjectiveReportPath(
      remoteTarget,
      `fingerprint-${DISPATCH_ID}`
    )
    const adapter = createObjectiveSubmissionAdapter({
      runtime: {} as OrcaRuntimeService,
      objectiveStore: OBJECTIVE_STORE
    })

    await expect(
      adapter.preflightWorkerReport(
        {
          dispatchId: DISPATCH_ID,
          payload: { reportPath: remoteReportPath, filesModified: ['src/core.ts'] }
        },
        { enrollment: ENROLLMENT, snapshot: null, ledger: LEDGER }
      )
    ).resolves.toEqual({ status: 'accepted' })
    expect(fileProvider.realpath).toHaveBeenCalled()
  })
})
