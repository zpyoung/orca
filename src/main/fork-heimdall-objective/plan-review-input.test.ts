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
})
