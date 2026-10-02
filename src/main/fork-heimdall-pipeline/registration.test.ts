import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ObjectiveEnrollmentPayloadSchema,
  type ObjectiveEnrollmentPayload
} from '../../shared/fork-heimdall-objective/contract-types'
import {
  AuthorizedEnrollmentSchema,
  WatcherEnrollmentSchema,
  type EnrollInput,
  type WatcherEnrollment
} from '../../shared/fork-heimdall/watcher-types'
import {
  BUILTIN_OBJECTIVE_PIPELINE_TEXT,
  builtinPipelinePin
} from '../../shared/fork-heimdall-pipeline/builtin-pipelines'
import { PipelineEnrollmentPayloadSchema } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import { objectiveKindPayloadFromDocument } from '../../shared/fork-heimdall-pipeline/enrollment-routing'
import { pipelineContentHash } from '../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { parsePipelineText } from '../../shared/fork-heimdall-pipeline/pipeline-parse'
import type { PipelinePin } from '../../shared/fork-heimdall-pipeline/pipeline-pin'
import { PipelineDatabase } from './pipeline-database'
import { PipelineStore } from './pipeline-store'
import { recordPipelineRunPin, validateCopiedPipelineEnrollmentSource } from './registration'

let database: PipelineDatabase
let pipelineStore: PipelineStore
beforeEach(() => {
  database = new PipelineDatabase(':memory:')
  pipelineStore = new PipelineStore(database)
})

const sourceText = BUILTIN_OBJECTIVE_PIPELINE_TEXT
const parsedSource = parsePipelineText(sourceText)
if (parsedSource.document === null) {
  throw new Error('The copied Objective pipeline fixture must parse')
}
const document = parsedSource.document
const pin: PipelinePin = {
  ref: 'repo:objective-copy',
  scope: 'repo',
  id: document.id,
  contentHash: pipelineContentHash(document),
  documentVersion: document.version
}
const objectivePayload: ObjectiveEnrollmentPayload = ObjectiveEnrollmentPayloadSchema.parse(
  objectiveKindPayloadFromDocument(document, {
    objectiveText: 'Build the requested change',
    workspaceKind: 'git'
  })
)
const source = { sourceText }

function customPipelinePayload(sourceText: string) {
  const parsed = parsePipelineText(sourceText)
  if (parsed.document === null) {
    throw new Error('The custom pipeline fixture must parse')
  }
  const customPin: PipelinePin = {
    ref: 'user:custom-copy',
    scope: 'user',
    id: parsed.document.id,
    contentHash: pipelineContentHash(parsed.document),
    documentVersion: parsed.document.version
  }
  return PipelineEnrollmentPayloadSchema.parse({
    schemaVersion: 1,
    pin: customPin,
    document: parsed.document,
    sourceText,
    runInputs: {},
    workspaceKind: 'git'
  })
}

function enrollment(
  watcherId: string,
  kind: WatcherEnrollment['kind'],
  kindPayload: unknown,
  enabled: boolean
): WatcherEnrollment {
  return WatcherEnrollmentSchema.parse({
    watcherId,
    kind,
    workspaceKey: 'local::/workspace/objective-copy',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    workspacePath: '/workspace/objective-copy',
    schedulerOwner: 'local_host_service',
    enabled,
    paused: false,
    commandRevision: 0,
    capabilities: { plan: 'on' },
    budget: { wallClockActiveMs: 60_000, turns: 4 },
    kindPayload,
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane-1' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null
  })
}

function objectiveInput(overrides: Partial<EnrollInput> = {}): EnrollInput {
  return {
    kind: 'objective',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    capabilities: { plan: 'on' },
    budget: { wallClockActiveMs: 60_000, turns: 4 },
    kindPayload: objectivePayload,
    ...overrides
  }
}

function authorizedObjective(payload: ObjectiveEnrollmentPayload = objectivePayload) {
  return AuthorizedEnrollmentSchema.parse({
    kind: 'objective',
    workspaceKey: 'local::/workspace/objective-copy',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    workspacePath: '/workspace/objective-copy',
    schedulerOwner: 'local_host_service',
    capabilities: { plan: 'on' },
    budget: { wallClockActiveMs: 60_000, turns: 4 },
    kindPayload: payload
  })
}

afterEach(() => database.close())

describe('pipeline pin registration', () => {
  it('records custom and copied source snapshots on first insert and never replaces the original', () => {
    const customText = `version: 1\nid: custom-copy\nname: Custom copy\nnodes:\n  - id: implement\n    type: agent\n    prompt: Implement the requested change\n`
    const payload = customPipelinePayload(customText)
    const custom = enrollment('custom-run', 'pipeline', payload, true)
    recordPipelineRunPin(pipelineStore, custom, {
      kind: 'pipeline',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      capabilities: {},
      budget: { wallClockActiveMs: 60_000, turns: 4 },
      kindPayload: payload
    })
    expect(pipelineStore.runPin('custom-run')).toEqual({ ...payload.pin, runNumber: 1 })
    expect(pipelineStore.runSource('custom-run')).toEqual({ sourceText: customText })
    const secondCustom = enrollment('custom-run-2', 'pipeline', payload, true)
    recordPipelineRunPin(pipelineStore, secondCustom, {
      kind: 'pipeline',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      capabilities: {},
      budget: { wallClockActiveMs: 60_000, turns: 4 },
      kindPayload: payload
    })
    expect(pipelineStore.runPin('custom-run-2')).toEqual({ ...payload.pin, runNumber: 2 })

    const copied = enrollment('objective-run', 'objective', objectivePayload, true)
    recordPipelineRunPin(pipelineStore, copied, {
      ...objectiveInput(),
      pipelinePin: pin,
      pipelineSource: source
    })
    expect(pipelineStore.runPin('objective-run')).toEqual({ ...pin, runNumber: 1 })
    expect(pipelineStore.runSource('objective-run')).toEqual(source)

    recordPipelineRunPin(pipelineStore, copied, {
      ...objectiveInput(),
      pipelinePin: { ...pin, contentHash: `sha256:${'b'.repeat(64)}` },
      pipelineSource: { sourceText: 'replacement source' }
    })
    expect(pipelineStore.runPin('objective-run')).toEqual({ ...pin, runNumber: 1 })
    expect(pipelineStore.runSource('objective-run')).toEqual(source)
    const builtin = enrollment('objective-builtin', 'objective', objectivePayload, true)
    recordPipelineRunPin(pipelineStore, builtin, {
      ...objectiveInput(),
      pipelinePin: builtinPipelinePin('objective')
    })
    expect(pipelineStore.runPin('objective-builtin')).toEqual({
      ...builtinPipelinePin('objective'),
      runNumber: 1
    })
    expect(pipelineStore.runSource('objective-builtin')).toBeNull()
  })

  it('validates a source-pinned re-arm from stored metadata when the incoming input omits it', () => {
    const existing = enrollment('objective-copy', 'objective', objectivePayload, false)
    pipelineStore.recordRunPin(existing.watcherId, pin, 1, source)
    const input = objectiveInput({ pipelinePin: undefined, pipelineSource: undefined })

    expect(
      validateCopiedPipelineEnrollmentSource(input, authorizedObjective(), existing, pipelineStore)
    ).toBeNull()

    const changed = authorizedObjective({ ...objectivePayload, objectiveText: 'Changed task' })
    expect(
      validateCopiedPipelineEnrollmentSource(input, changed, existing, pipelineStore)
    ).toMatchObject({ status: 'refused', reason: 'invalid-payload' })
    expect(pipelineStore.runPin(existing.watcherId)).toEqual({ ...pin, runNumber: 1 })
    expect(pipelineStore.runSource(existing.watcherId)).toEqual(source)
  })
})
