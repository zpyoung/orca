import { afterEach, describe, expect, it } from 'vitest'
import {
  ObjectiveEnrollmentPayloadSchema,
  type ObjectiveEnrollmentPayload
} from '../../shared/fork-heimdall-objective/contract-types'
import {
  AuthorizedEnrollmentSchema,
  WatcherEnrollmentSchema
} from '../../shared/fork-heimdall/watcher-types'
import type { EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import {
  PIPELINE_NODE_TYPES,
  type NodeType
} from '../../shared/fork-heimdall-pipeline/document-schema'
import { builtinPipelinePin } from '../../shared/fork-heimdall-pipeline/builtin-pipelines'
import {
  objectiveKindPayloadFromDocument,
  sitterKindPayloadFromDocument
} from '../../shared/fork-heimdall-pipeline/enrollment-routing'
import { pipelineContentHash } from '../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { parsePipelineText } from '../../shared/fork-heimdall-pipeline/pipeline-parse'
import type { PipelinePin } from '../../shared/fork-heimdall-pipeline/pipeline-pin'
import type { PipelineSourceSnapshot } from '../../shared/fork-heimdall-pipeline/pipeline-source'
import { PipelineDatabase } from './pipeline-database'
import { PipelineStore } from './pipeline-store'
import { validatePipelineEnrollmentSource } from './pipeline-source-validation'

const SOURCE: PipelineSourceSnapshot = {
  sourceText: `version: 1
id: objective-copy
name: Objective copy
nodes:
  - id: objective
    type: objective
    tier: standard
    landingBar: files-on-disk
`
}
const parsedSource = parsePipelineText(SOURCE.sourceText)
if (parsedSource.document === null) {
  throw new Error('Objective source fixture must parse')
}
const PIN: PipelinePin = {
  ref: 'objective-copy',
  scope: 'repo',
  id: parsedSource.document.id,
  contentHash: pipelineContentHash(parsedSource.document),
  documentVersion: 1
}
const OBJECTIVE_PAYLOAD: ObjectiveEnrollmentPayload = ObjectiveEnrollmentPayloadSchema.parse(
  objectiveKindPayloadFromDocument(parsedSource.document, {
    objectiveText: 'Implement the requested task',
    workspaceKind: 'git'
  })
)

const SITTER_SOURCE: PipelineSourceSnapshot = {
  sourceText: `version: 1
id: sitter-copy
name: Sitter copy
nodes:
  - id: sitter
    type: pr-sitter
    repeatFixLimit: 4
    branchUpdateMode: rebase
    mergeMethod: squash
    mergeCheckScope: required
`
}
const parsedSitterSource = parsePipelineText(SITTER_SOURCE.sourceText)
if (parsedSitterSource.document === null) {
  throw new Error('PR-sitter source fixture must parse')
}
const SITTER_PIN: PipelinePin = {
  ref: 'sitter-copy',
  scope: 'user',
  id: parsedSitterSource.document.id,
  contentHash: pipelineContentHash(parsedSitterSource.document),
  documentVersion: 1
}
const SITTER_PAYLOAD = {
  branch: 'feature/review',
  provider: 'github',
  reviewNumber: 42,
  reviewUrl: 'https://example.test/reviews/42',
  ...sitterKindPayloadFromDocument(parsedSitterSource.document)
}
const BUDGET = { wallClockActiveMs: 60_000, turns: 2 }
const opened: PipelineDatabase[] = []

afterEach(() => {
  for (const database of opened) {
    database.close()
  }
  opened.length = 0
})

function enrollmentInput(overrides: Partial<EnrollInput> = {}): EnrollInput {
  return {
    kind: 'objective',
    repoId: 'repo-1',
    worktreeId: null,
    capabilities: { plan: 'on' },
    budget: BUDGET,
    kindPayload: OBJECTIVE_PAYLOAD,
    pipelinePin: PIN,
    pipelineSource: SOURCE,
    ...overrides
  }
}

function authorized(
  kindPayload: ObjectiveEnrollmentPayload = OBJECTIVE_PAYLOAD,
  overrides: { capabilities?: Record<string, 'off' | 'gated' | 'on'>; budget?: typeof BUDGET } = {}
) {
  return AuthorizedEnrollmentSchema.parse({
    kind: 'objective',
    workspaceKey: 'local::/workspace/copy',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: null,
    workspacePath: '/workspace/copy',
    schedulerOwner: 'local_host_service',
    capabilities: overrides.capabilities ?? { plan: 'on' },
    budget: overrides.budget ?? BUDGET,
    kindPayload
  })
}

function existingEnrollment(kindPayload: ObjectiveEnrollmentPayload = OBJECTIVE_PAYLOAD) {
  return WatcherEnrollmentSchema.parse({
    watcherId: 'watcher-copy',
    kind: 'objective',
    workspaceKey: 'local::/workspace/copy',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: null,
    workspacePath: '/workspace/copy',
    schedulerOwner: 'local_host_service',
    enabled: false,
    paused: false,
    commandRevision: 1,
    capabilities: { plan: 'on' },
    budget: BUDGET,
    kindPayload,
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane-1' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null
  })
}

function sitterInput(overrides: Partial<EnrollInput> = {}): EnrollInput {
  return {
    kind: 'hosted-review',
    repoId: 'repo-1',
    worktreeId: null,
    capabilities: { merge: 'on' },
    budget: BUDGET,
    kindPayload: SITTER_PAYLOAD,
    pipelinePin: SITTER_PIN,
    pipelineSource: SITTER_SOURCE,
    ...overrides
  }
}

function authorizedSitter(kindPayload = SITTER_PAYLOAD) {
  return AuthorizedEnrollmentSchema.parse({
    kind: 'hosted-review',
    workspaceKey: 'local::/workspace/review',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: null,
    workspacePath: '/workspace/review',
    schedulerOwner: 'local_host_service',
    capabilities: { merge: 'on' },
    budget: BUDGET,
    kindPayload
  })
}

describe('validatePipelineEnrollmentSource', () => {
  it('requires and verifies a copied legacy source pin before enrollment', () => {
    const database = new PipelineDatabase(':memory:')
    opened.push(database)
    const store = new PipelineStore(database)
    const input = enrollmentInput()

    expect(
      validatePipelineEnrollmentSource({
        input,
        authorized: authorized(),
        pipelineStore: store,
        workspaceKind: 'git'
      })
    ).toEqual({ refusal: null, source: SOURCE })

    const missingSource = validatePipelineEnrollmentSource({
      input: enrollmentInput({ pipelineSource: undefined }),
      authorized: authorized(),
      pipelineStore: store,
      workspaceKind: 'git'
    })
    expect(missingSource.refusal).toMatchObject({ status: 'refused', reason: 'invalid-payload' })

    const badHash = validatePipelineEnrollmentSource({
      input: enrollmentInput({ pipelinePin: { ...PIN, contentHash: `sha256:${'b'.repeat(64)}` } }),
      authorized: authorized(),
      pipelineStore: store,
      workspaceKind: 'git'
    })
    expect(badHash.refusal).toMatchObject({ status: 'refused', reason: 'invalid-payload' })

    const badId = validatePipelineEnrollmentSource({
      input: enrollmentInput({ pipelinePin: { ...PIN, id: 'different-id' } }),
      authorized: authorized(),
      pipelineStore: store,
      workspaceKind: 'git'
    })
    expect(badId.refusal).toMatchObject({ status: 'refused', reason: 'invalid-payload' })

    const wrongRoute = validatePipelineEnrollmentSource({
      input,
      authorized: authorizedSitter(),
      pipelineStore: store,
      workspaceKind: 'git'
    })
    expect(wrongRoute.refusal).toMatchObject({ status: 'refused', reason: 'invalid-payload' })

    const duplicatePipelineSource = validatePipelineEnrollmentSource({
      input: { ...input, kind: 'pipeline' },
      authorized: { ...authorized(), kind: 'pipeline' },
      pipelineStore: store,
      workspaceKind: 'git'
    })
    expect(duplicatePipelineSource.refusal).toMatchObject({
      status: 'refused',
      reason: 'invalid-payload'
    })

    const changedSettings = validatePipelineEnrollmentSource({
      input,
      authorized: authorized(
        ObjectiveEnrollmentPayloadSchema.parse({
          ...OBJECTIVE_PAYLOAD,
          landingBar: 'hosted-review'
        })
      ),
      pipelineStore: store,
      workspaceKind: 'git'
    })
    expect(changedSettings.refusal).toMatchObject({ status: 'refused', reason: 'invalid-payload' })

    const unsupportedTypes = new Set<NodeType>(
      PIPELINE_NODE_TYPES.filter((type) => type !== 'objective')
    )
    const unsupportedHost = validatePipelineEnrollmentSource({
      input,
      authorized: authorized(),
      pipelineStore: store,
      workspaceKind: 'git',
      hostNodeTypes: unsupportedTypes
    })
    expect(unsupportedHost.refusal).toMatchObject({ status: 'refused', reason: 'invalid-payload' })
  })

  it('validates copied PR-sitter settings from source rather than trusting the kind payload', () => {
    const database = new PipelineDatabase(':memory:')
    opened.push(database)
    const store = new PipelineStore(database)
    const input = sitterInput()

    expect(
      validatePipelineEnrollmentSource({
        input,
        authorized: authorizedSitter(),
        pipelineStore: store,
        workspaceKind: 'git'
      })
    ).toEqual({ refusal: null, source: SITTER_SOURCE })

    const changedSettings = validatePipelineEnrollmentSource({
      input,
      authorized: authorizedSitter({ ...SITTER_PAYLOAD, repeatFixLimit: 5 }),
      pipelineStore: store,
      workspaceKind: 'git'
    })
    expect(changedSettings.refusal).toMatchObject({ status: 'refused', reason: 'invalid-payload' })
  })

  it('keeps display-only built-in pins source-free and refuses copied pins with missing stored snapshots', () => {
    const database = new PipelineDatabase(':memory:')
    opened.push(database)
    const store = new PipelineStore(database)
    const builtinInput = enrollmentInput({
      pipelinePin: builtinPipelinePin('objective'),
      pipelineSource: undefined
    })
    expect(
      validatePipelineEnrollmentSource({
        input: builtinInput,
        authorized: authorized(),
        pipelineStore: store,
        workspaceKind: 'git'
      })
    ).toEqual({ refusal: null, source: null })

    store.recordRunPin('watcher-copy', PIN, 1)
    const missingSavedSource = validatePipelineEnrollmentSource({
      input: enrollmentInput({ pipelineSource: undefined }),
      authorized: authorized(),
      existing: existingEnrollment(),
      pipelineStore: store,
      workspaceKind: 'git'
    })
    expect(missingSavedSource.refusal).toMatchObject({
      status: 'refused',
      reason: 'invalid-payload'
    })
  })

  it('pins source identity and kind payload across rearm while allowing grants and budget changes', () => {
    const database = new PipelineDatabase(':memory:')
    opened.push(database)
    const store = new PipelineStore(database)
    store.recordRunPin('watcher-copy', PIN, 1, SOURCE)

    const stableRearm = validatePipelineEnrollmentSource({
      input: enrollmentInput(),
      authorized: authorized(OBJECTIVE_PAYLOAD, {
        capabilities: { plan: 'off', implement: 'on' },
        budget: { wallClockActiveMs: 120_000, turns: 8 }
      }),
      existing: existingEnrollment(),
      pipelineStore: store,
      workspaceKind: 'git'
    })
    expect(stableRearm).toEqual({ refusal: null, source: SOURCE })

    const omittedMetadataRearm = validatePipelineEnrollmentSource({
      input: enrollmentInput({ pipelinePin: undefined, pipelineSource: undefined }),
      authorized: authorized(OBJECTIVE_PAYLOAD, {
        capabilities: { plan: 'off' },
        budget: { wallClockActiveMs: 120_000, turns: 8 }
      }),
      existing: existingEnrollment(),
      pipelineStore: store,
      workspaceKind: 'git'
    })
    expect(omittedMetadataRearm).toEqual({ refusal: null, source: SOURCE })

    const changedTask = validatePipelineEnrollmentSource({
      input: enrollmentInput(),
      authorized: authorized(
        ObjectiveEnrollmentPayloadSchema.parse({
          ...OBJECTIVE_PAYLOAD,
          objectiveText: 'Different task'
        })
      ),
      existing: existingEnrollment(),
      pipelineStore: store,
      workspaceKind: 'git'
    })
    expect(changedTask.refusal).toMatchObject({ status: 'refused', reason: 'invalid-payload' })

    const changedPin = validatePipelineEnrollmentSource({
      input: enrollmentInput({ pipelinePin: { ...PIN, ref: 'different-ref' } }),
      authorized: authorized(),
      existing: existingEnrollment(),
      pipelineStore: store,
      workspaceKind: 'git'
    })
    expect(changedPin.refusal).toMatchObject({ status: 'refused', reason: 'invalid-payload' })
  })

  it('refuses corrupted persisted source before enrollment mutation', () => {
    const database = new PipelineDatabase(':memory:')
    opened.push(database)
    const store = new PipelineStore(database)
    store.recordRunPin('watcher-copy', PIN, 1, SOURCE)
    database
      .connection()
      .prepare('UPDATE pipeline_run_pin SET source_text = ? WHERE watcher_id = ?')
      .run('x'.repeat(262_145), 'watcher-copy')

    const decision = validatePipelineEnrollmentSource({
      input: enrollmentInput(),
      authorized: authorized(),
      existing: existingEnrollment(),
      pipelineStore: store,
      workspaceKind: 'git'
    })
    expect(decision.refusal).toMatchObject({ status: 'refused', reason: 'invalid-payload' })
    expect(decision.source).toBeNull()
  })
})
