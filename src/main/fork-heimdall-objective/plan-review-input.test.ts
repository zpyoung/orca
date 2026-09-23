import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ObjectivePlanLint } from '../../shared/fork-heimdall-objective/plan-lint'
import type { ObjectivePlanTask } from '../../shared/fork-heimdall-objective/plan-schema'
import type { IFilesystemProvider } from '../providers/types'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import { issueObjectiveReportPath } from './report-ingestion'
import {
  buildPlanReviewInput,
  writePlanReviewInputFile,
  type PlanReviewInput
} from './plan-review-input'

const LINT: ObjectivePlanLint = {
  findings: [],
  truncated: false,
  conflictPairs: [],
  criticalPathLength: 1,
  maxWidth: 1
}

function task(overrides: Partial<ObjectivePlanTask> = {}): ObjectivePlanTask {
  return {
    taskKey: 'core',
    title: 'Core',
    spec: 'Implement the core behavior.',
    deps: [],
    criteria: [{ body: 'Works', shellCheckable: false, checkCommand: null }],
    declaresDependencyChange: false,
    ...overrides
  }
}

function input(overrides: Partial<PlanReviewInput> = {}): PlanReviewInput {
  return {
    target: { kind: 'revision', revisionId: 'revision-1' },
    plan: [task()],
    assumptions: [],
    lint: LINT,
    writeTerritory: ['src/**'],
    gates: undefined,
    effectiveMaxConcurrency: 1,
    ...overrides
  }
}

const temporaryDirectories: string[] = []

async function localFolderTarget(): Promise<ObjectiveWorkspaceTarget> {
  const workspacePath = await mkdtemp(join(tmpdir(), 'orca-plan-review-input-'))
  temporaryDirectories.push(workspacePath)
  return { kind: 'folder', executionHostId: 'local', workspacePath, fileProvider: null }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('buildPlanReviewInput', () => {
  it('passes a small input through unchanged', () => {
    const built = buildPlanReviewInput(input())
    expect(built).toEqual(input())
  })

  it('carries a patch and frozen tasks through untouched when they fit', () => {
    const patch = { repair: { upsertTasks: [task({ taskKey: 'core-2' })], dropTaskKeys: [] } }
    const built = buildPlanReviewInput(
      input({
        target: { kind: 'patch', patchId: 'patch-1' },
        patch,
        frozenTasks: [{ taskKey: 'core', title: 'Core' }]
      })
    )
    expect(built.patch).toEqual(patch)
    expect(built.frozenTasks).toEqual([{ taskKey: 'core', title: 'Core' }])
  })

  it('truncates the longest task spec first until the input fits the 1 MiB cap', () => {
    const huge = 'x'.repeat(600_000)
    const built = buildPlanReviewInput(
      input({ plan: [task({ taskKey: 'a', spec: huge }), task({ taskKey: 'b', spec: huge })] })
    )
    const bytes = Buffer.byteLength(JSON.stringify(built), 'utf8')
    expect(bytes).toBeLessThanOrEqual(1024 * 1024)
    expect(built.plan.some((candidate) => candidate.spec.endsWith('…[truncated]'))).toBe(true)
    expect(built.plan.find((candidate) => candidate.taskKey === 'a')?.spec.length).toBeLessThan(
      huge.length
    )
  })

  it('truncates a criterion body once no spec is left above target, until the input fits', () => {
    const huge = 'y'.repeat(1_200_000)
    const built = buildPlanReviewInput(
      input({
        plan: [task({ criteria: [{ body: huge, shellCheckable: false, checkCommand: null }] })]
      })
    )
    const bytes = Buffer.byteLength(JSON.stringify(built), 'utf8')
    expect(bytes).toBeLessThanOrEqual(1024 * 1024)
    expect(built.plan[0]?.criteria[0]?.body.endsWith('…[truncated]')).toBe(true)
    expect(built.plan[0]?.criteria[0]?.body.length).toBeLessThan(huge.length)
  })

  it('truncates an assumption claim once no spec or criterion is left above target', () => {
    const huge = 'z'.repeat(1_200_000)
    const built = buildPlanReviewInput(
      input({ assumptions: [{ claim: huge, dependentTaskKeys: [] }] })
    )
    const bytes = Buffer.byteLength(JSON.stringify(built), 'utf8')
    expect(bytes).toBeLessThanOrEqual(1024 * 1024)
    expect(built.assumptions[0]?.claim.endsWith('…[truncated]')).toBe(true)
  })

  it('never re-selects an already-truncated field, so shrinking terminates', () => {
    const huge = 'w'.repeat(1_200_000)
    const built = buildPlanReviewInput(input({ plan: [task({ spec: huge })] }))
    // truncating twice would grow the marker back on, not shrink it further
    expect(built.plan[0]?.spec).toBe(`${huge.slice(0, 200)}…[truncated]`)
  })

  it('stays oversized when every field is already within target but there are too many of them', () => {
    const plan = Array.from({ length: 128 }, (_, taskIndex) =>
      task({
        taskKey: `task-${taskIndex}`,
        spec: 'ok',
        criteria: Array.from({ length: 64 }, (_, criterionIndex) => ({
          body: `criterion-${taskIndex}-${criterionIndex}-${'c'.repeat(150)}`,
          shellCheckable: false,
          checkCommand: null
        }))
      })
    )
    const built = buildPlanReviewInput(input({ plan }))
    const bytes = Buffer.byteLength(JSON.stringify(built), 'utf8')
    expect(bytes).toBeGreaterThan(1024 * 1024)
  })
})

describe('writePlanReviewInputFile', () => {
  it('writes the input JSON beside a local report path with mode 0600', async () => {
    const target = await localFolderTarget()
    const reportPath = await issueObjectiveReportPath(target, 'attempt-1')

    const written = await writePlanReviewInputFile(target, reportPath, input())

    expect(written).toBe(reportPath.replace(/\.json$/u, '.plan-review-input.json'))
    const contents = await readFile(written, 'utf8')
    expect(JSON.parse(contents)).toEqual(input())
    const mode = (await stat(written)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('writes through the file provider for a remote target', async () => {
    const writeFileMock = vi.fn().mockResolvedValue(undefined)
    const target: ObjectiveWorkspaceTarget = {
      kind: 'folder',
      executionHostId: 'ssh:plan-review-input-test',
      workspacePath: '/srv/objective',
      fileProvider: { writeFile: writeFileMock } as unknown as IFilesystemProvider
    }
    const reportPath = '/srv/objective/.orca/heimdall/objective/reports/deadbeef.json'

    const written = await writePlanReviewInputFile(target, reportPath, input())

    expect(written).toBe(
      '/srv/objective/.orca/heimdall/objective/reports/deadbeef.plan-review-input.json'
    )
    expect(writeFileMock).toHaveBeenCalledWith(written, JSON.stringify(input()))
  })

  it('fails the dispatch instead of writing a file still oversized after every field is trimmed', async () => {
    const target = await localFolderTarget()
    const reportPath = await issueObjectiveReportPath(target, 'attempt-oversized')
    const plan = Array.from({ length: 128 }, (_, taskIndex) =>
      task({
        taskKey: `task-${taskIndex}`,
        spec: 'ok',
        criteria: Array.from({ length: 64 }, (_, criterionIndex) => ({
          body: `criterion-${taskIndex}-${criterionIndex}-${'c'.repeat(150)}`,
          shellCheckable: false,
          checkCommand: null
        }))
      })
    )
    const oversized = buildPlanReviewInput(input({ plan }))

    await expect(writePlanReviewInputFile(target, reportPath, oversized)).rejects.toThrow(
      /exceeding the 1048576-byte cap/
    )
    await expect(
      readFile(reportPath.replace(/\.json$/u, '.plan-review-input.json'), 'utf8')
    ).rejects.toThrow()
  })
})
