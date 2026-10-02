import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getObjectiveHeimdallApi } from '../fork-heimdall-objective/objective-heimdall-api'
import type { ObjectiveEnrollmentSubmission } from '../fork-heimdall-objective/objective-enrollment-request'
import type { ObjectiveWorkspaceOption } from '../fork-heimdall-objective/objective-workspace-options'
import { ensureLocalRuntimeCapabilities } from '../runtime/local-runtime-capabilities'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import {
  ObjectiveEnrollmentPayloadSchema,
  ObjectiveEnrollmentRequestSchema
} from '../../../shared/fork-heimdall-objective/contract-types'
import {
  defaultGrants,
  requestedCapabilities,
  PIPELINE_USER_CAPABILITY_KEYS,
  type PipelineCapabilityModes,
  type PipelineUserCapabilityKey
} from '../../../shared/fork-heimdall-pipeline/capability-grants'
import { HEIMDALL_PIPELINE_RUNTIME_CAPABILITY } from '../../../shared/fork-heimdall-pipeline/capability'
import {
  BUILTIN_PIPELINE_TEXTS,
  builtinPipelinePin,
  type BuiltinPipelineId
} from '../../../shared/fork-heimdall-pipeline/builtin-pipelines'
import { PipelineEnrollmentRequestSchema } from '../../../shared/fork-heimdall-pipeline/enrollment-payload'
import {
  objectiveKindPayloadFromDocument,
  routeEnrollmentKind,
  sitterKindPayloadFromDocument
} from '../../../shared/fork-heimdall-pipeline/enrollment-routing'
import { parsePipelineRef } from '../../../shared/fork-heimdall-pipeline/pipeline-ref'
import { pipelineContentHash } from '../../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { parsePipelineText } from '../../../shared/fork-heimdall-pipeline/pipeline-parse'
import { validatePipeline } from '../../../shared/fork-heimdall-pipeline/pipeline-validate'
import type { PipelinePin } from '../../../shared/fork-heimdall-pipeline/pipeline-pin'
import type { PipelineResolveResponse } from '../../../shared/fork-heimdall-pipeline/rpc-schemas'
import type { PipelineDocument } from '../../../shared/fork-heimdall-pipeline/document-schema'
import type { CapabilityMode, EnrollInput } from '../../../shared/fork-heimdall/watcher-types'
import type { BudgetPolicy } from '../../../shared/fork-heimdall/budget'
import type { ObjectiveNewWorktreeRequest } from '../../../shared/fork-heimdall-objective/contract-types'

export type PipelineRunStartRef = {
  ref: string
  worktree: ObjectiveWorkspaceOption
  grants: PipelineCapabilityModes
  runInputs: Readonly<Record<string, string | number | boolean>>
  budget: BudgetPolicy
  owner?: ObjectiveWorkspaceOption['owner']
  objectiveSubmission?: ObjectiveEnrollmentSubmission
  newWorktree?: ObjectiveNewWorktreeRequest
}

type PipelineSource = {
  ref: string
  scope: 'builtin' | 'repo' | 'user'
  id: string
  sourceText: string
  document: PipelineDocument
  pin: PipelinePin
}

function sourceError(
  errors: readonly { nodeId: string | null; code: string; message: string }[]
): Error {
  return new Error(
    errors.map((error) => `${error.nodeId ?? '-'} ${error.code}: ${error.message}`).join('\n')
  )
}

async function readPipelineSource(
  refText: string,
  worktree: ObjectiveWorkspaceOption
): Promise<PipelineSource> {
  const ref = parsePipelineRef(refText)
  if ('error' in ref || ref.scope === 'path') {
    throw new Error(
      translate(
        'fork.heimdallPipeline.error.invalidReference',
        'Choose a built-in, repository, or personal pipeline by its scoped name.'
      )
    )
  }

  let sourceText: string
  let remoteErrors: PipelineResolveResponse['errors'] = []
  let builtinId: BuiltinPipelineId | null = null
  if (ref.scope === 'builtin') {
    if (!isBuiltinPipelineId(ref.id)) {
      throw new Error(
        translate(
          'fork.heimdallPipeline.error.builtinMissing',
          'This built-in pipeline {{id}} is unavailable.',
          { id: ref.id }
        )
      )
    }
    builtinId = ref.id
    sourceText = BUILTIN_PIPELINE_TEXTS[builtinId]
  } else if (ref.scope === 'user') {
    const api = getObjectiveHeimdallApi()
    if (typeof api?.pipelinePersonal !== 'function') {
      throw new Error(
        translate(
          'fork.heimdallPipeline.error.userScopeUnavailable',
          'Personal pipeline storage is not available in this workspace.'
        )
      )
    }
    const personal = await api.pipelinePersonal({ op: 'read', id: ref.id })
    if (!('yamlText' in personal)) {
      throw new Error(
        translate(
          'fork.heimdallPipeline.error.personalUnavailable',
          'Personal pipeline {{id}} could not be read.',
          { id: ref.id }
        )
      )
    }
    sourceText = personal.yamlText
  } else {
    const api = getObjectiveHeimdallApi()
    if (typeof api?.pipelineResolve !== 'function') {
      throw new Error(
        translate(
          'fork.heimdallPipeline.error.repositoryUnavailable',
          'Repository pipeline service is unavailable on this host.'
        )
      )
    }
    const resolved = await api.pipelineResolve({
      workspace: { repoId: worktree.repoId, worktreeId: worktree.worktreeId },
      ref: ref.id
    })
    if (resolved.scope !== 'repo' || resolved.id !== ref.id || resolved.ref !== ref.id) {
      throw new Error(
        translate(
          'fork.heimdallPipeline.error.sourceMismatch',
          'Repository pipeline {{id}} resolved to a different source.',
          { id: ref.id }
        )
      )
    }
    sourceText = resolved.sourceText
    remoteErrors = resolved.errors
  }

  const parsed = parsePipelineText(sourceText)
  if (parsed.document === null) {
    throw sourceError(parsed.errors)
  }
  const errors = [
    ...validatePipeline(parsed.document, {
      workspaceKind: worktree.workspaceKind,
      expectedId: ref.id
    }),
    ...remoteErrors
  ]
  if (errors.length > 0) {
    throw sourceError(errors)
  }
  const document = parsed.document
  const pin =
    builtinId === null
      ? {
          ref: refText,
          scope: ref.scope,
          id: ref.id,
          contentHash: pipelineContentHash(document),
          documentVersion: document.version
        }
      : builtinPipelinePin(builtinId)
  if (pin.contentHash !== pipelineContentHash(document)) {
    throw new Error(
      translate(
        'fork.heimdallPipeline.error.sourceChanged',
        'The pipeline source changed while it was being resolved.'
      )
    )
  }
  return { ref: refText, scope: ref.scope, id: ref.id, sourceText, document, pin }
}

function isBuiltinPipelineId(id: string): id is BuiltinPipelineId {
  return id === 'objective' || id === 'pr-sitter'
}

async function pipelineRuntimeCapabilities(
  worktree: ObjectiveWorkspaceOption
): Promise<readonly string[] | null> {
  const state = useAppStore.getState()
  const repo = state.repos.find((candidate) => candidate.id === worktree.repoId)
  const hostId = worktree.worktreeId
    ? getExecutionHostIdForWorktree(state, worktree.worktreeId)
    : repo
      ? getRepoExecutionHostId(repo)
      : 'local'
  const host = parseExecutionHostId(hostId)
  if (host?.kind === 'runtime') {
    return state.runtimeStatusByEnvironmentId.get(host.environmentId)?.status?.capabilities ?? null
  }
  return ensureLocalRuntimeCapabilities()
}

const SITTER_GRANT_KEYS = ['updateBranch', 'resolveConflicts', 'fixChecks', 'merge'] as const

function grantsWithOverrides(
  defaults: PipelineCapabilityModes,
  overrides: PipelineCapabilityModes
): Record<string, CapabilityMode> {
  const result: Record<string, CapabilityMode> = {}
  for (const key of PIPELINE_USER_CAPABILITY_KEYS) {
    const mode = defaults[key]
    if (mode !== undefined) {
      result[key] = overrides[key] ?? mode
    }
  }
  return result
}

function sitterGrants(grants: PipelineCapabilityModes): Record<string, CapabilityMode> {
  const result: Record<string, CapabilityMode> = {}
  for (const key of SITTER_GRANT_KEYS) {
    const mode = grants[key]
    if (mode !== undefined) {
      result[key] = mode
    }
  }
  return result
}

function copyOfPipelinePin(pin: PipelinePin): PipelinePin {
  return {
    ref: pin.ref,
    scope: pin.scope,
    id: pin.id,
    contentHash: pin.contentHash,
    documentVersion: pin.documentVersion
  }
}

function objectiveInputForCopiedPipeline(
  input: EnrollInput,
  source: PipelineSource,
  worktree: ObjectiveWorkspaceOption
): EnrollInput {
  const request = ObjectiveEnrollmentRequestSchema.safeParse(input.kindPayload)
  if (!request.success) {
    throw new Error(
      translate(
        'fork.heimdallPipeline.runForm.objectiveFieldsInvalid',
        'Objective enrollment fields are invalid.'
      )
    )
  }
  const expectedPayload = ObjectiveEnrollmentPayloadSchema.parse(
    objectiveKindPayloadFromDocument(source.document, {
      objectiveText: request.data.objectiveText,
      workspaceKind: worktree.workspaceKind
    })
  )
  const submittedPayload = ObjectiveEnrollmentPayloadSchema.parse(request.data)
  if (JSON.stringify(expectedPayload) !== JSON.stringify(submittedPayload)) {
    throw new Error(
      translate(
        'fork.heimdallPipeline.runForm.objectiveSettingsMismatch',
        'Objective settings must match the saved pipeline. Edit and save the pipeline before starting this run.'
      )
    )
  }
  return {
    ...input,
    kindPayload: {
      ...expectedPayload,
      ...(request.data.newWorktree === undefined ? {} : { newWorktree: request.data.newWorktree })
    }
  }
}
function buildPipelineRunInputs(
  document: PipelineDocument,
  provided: Readonly<Record<string, string | number | boolean>>
): Record<string, string | number | boolean> {
  const invalidInput = (name: string): Error =>
    new Error(
      translate(
        'fork.heimdallPipeline.runForm.inputInvalid',
        'Run input {{name}} is missing or does not match its declared type.',
        { name }
      )
    )
  for (const name of Object.keys(provided)) {
    if (!Object.hasOwn(document.inputs, name)) {
      throw invalidInput(name)
    }
  }
  const values: Record<string, string | number | boolean> = {}
  for (const [name, definition] of Object.entries(document.inputs)) {
    const value = Object.hasOwn(provided, name) ? provided[name] : definition.default
    if (value === undefined) {
      if (definition.required) {
        throw invalidInput(name)
      }
      continue
    }
    const valid =
      definition.type === 'text'
        ? typeof value === 'string' && (!definition.required || value.trim().length > 0)
        : definition.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : typeof value === 'boolean'
    if (!valid) {
      throw invalidInput(name)
    }
    values[name] = value
  }
  return values
}

/** Enrolls from current saved source bytes; this function never reads canvas draft state. */
export async function startPipelineRun(input: PipelineRunStartRef) {
  const source = await readPipelineSource(input.ref, input.worktree)
  const route = routeEnrollmentKind(source.document)
  const api = getObjectiveHeimdallApi()
  if (!api) {
    throw new Error(
      translate(
        'fork.heimdallObjective.enrollment.serviceUnavailable',
        'Heimdall enrollment is not available in this client.'
      )
    )
  }
  const hostCapabilities = await pipelineRuntimeCapabilities(input.worktree)
  const pipelineSupported =
    hostCapabilities?.includes(HEIMDALL_PIPELINE_RUNTIME_CAPABILITY) === true
  if (
    (source.scope !== 'builtin' || route === 'pipeline') &&
    hostCapabilities !== null &&
    !pipelineSupported
  ) {
    throw new Error(
      translate(
        'fork.heimdallPipeline.error.sourcePinUnsupported',
        'Update Orca on the selected workspace host to run a copied pipeline (needs Heimdall Pipeline v1).'
      )
    )
  }

  let enrollInput: EnrollInput
  let owner = input.owner
  if (route === 'objective') {
    const submission = input.objectiveSubmission
    if (!submission || submission.input.kind !== 'objective') {
      throw new Error(
        translate(
          'fork.heimdallPipeline.runForm.objectiveFieldsRequired',
          'Objective enrollment fields are required for this pipeline.'
        )
      )
    }
    if (
      submission.input.repoId !== input.worktree.repoId ||
      submission.input.worktreeId !== input.worktree.worktreeId
    ) {
      throw new Error(
        translate(
          'fork.heimdallPipeline.runForm.workspaceChanged',
          'Objective workspace changed before the run started.'
        )
      )
    }
    enrollInput =
      source.scope === 'builtin'
        ? {
            ...submission.input,
            ...(pipelineSupported ? { pipelinePin: copyOfPipelinePin(source.pin) } : {})
          }
        : {
            ...objectiveInputForCopiedPipeline(submission.input, source, input.worktree),
            pipelinePin: copyOfPipelinePin(source.pin),
            pipelineSource: { sourceText: source.sourceText }
          }
    owner = submission.owner ?? owner
  } else if (route === 'hosted-review') {
    const defaults = defaultGrants(requestedCapabilities(source.document))
    enrollInput = {
      kind: 'hosted-review',
      repoId: input.worktree.repoId,
      worktreeId: input.worktree.worktreeId,
      capabilities: sitterGrants(grantsWithOverrides(defaults, input.grants)),
      budget: input.budget,
      kindPayload: sitterKindPayloadFromDocument(source.document),
      ...(source.scope === 'builtin'
        ? pipelineSupported
          ? { pipelinePin: copyOfPipelinePin(source.pin) }
          : {}
        : {
            pipelinePin: copyOfPipelinePin(source.pin),
            pipelineSource: { sourceText: source.sourceText }
          })
    }
  } else {
    const defaults = defaultGrants(requestedCapabilities(source.document))
    const kindPayload = PipelineEnrollmentRequestSchema.parse({
      schemaVersion: 1,
      pin: copyOfPipelinePin(source.pin),
      document: source.document,
      sourceText: source.sourceText,
      runInputs: buildPipelineRunInputs(source.document, input.runInputs),
      workspaceKind: input.worktree.workspaceKind,
      ...(input.newWorktree === undefined ? {} : { newWorktree: input.newWorktree })
    })
    enrollInput = {
      kind: 'pipeline',
      repoId: input.worktree.repoId,
      worktreeId: input.worktree.worktreeId,
      capabilities: grantsWithOverrides(defaults, input.grants),
      budget: input.budget,
      kindPayload
    }
  }
  return api.enroll(enrollInput, owner)
}

export function defaultPipelineGrants(document: PipelineDocument): PipelineCapabilityModes {
  return defaultGrants(requestedCapabilities(document))
}

export function pipelineCapabilityChoices(
  document: PipelineDocument
): { key: PipelineUserCapabilityKey; requested: CapabilityMode }[] {
  const requested = requestedCapabilities(document)
  return PIPELINE_USER_CAPABILITY_KEYS.flatMap((key) => {
    const mode = requested[key]
    return mode === undefined ? [] : [{ key, requested: mode }]
  })
}

export function describePipelineRunStartError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
