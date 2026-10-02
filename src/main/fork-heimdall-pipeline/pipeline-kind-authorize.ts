import { isDeepStrictEqual } from 'node:util'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { AutomationSchedulerOwner } from '../../shared/automations-types'
import {
  PIPELINE_CAPABILITY_KEYS,
  type PipelineDocument,
  type NodeType
} from '../../shared/fork-heimdall-pipeline/document-schema'
import {
  PipelineEnrollmentPayloadSchema,
  PipelineEnrollmentRequestSchema,
  type PipelineEnrollmentPayload,
  type PipelineEnrollmentRequest
} from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import { parsePipelineRef } from '../../shared/fork-heimdall-pipeline/pipeline-ref'
import { pipelineContentHash } from '../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { parsePipelineText } from '../../shared/fork-heimdall-pipeline/pipeline-parse'
import {
  validatePipeline,
  type PipelineValidationError
} from '../../shared/fork-heimdall-pipeline/pipeline-validate'
import { routeEnrollmentKind } from '../../shared/fork-heimdall-pipeline/enrollment-routing'
import type { EnrollmentAuthorizationScope } from '../../shared/fork-heimdall/kind-contract'
import type { AuthorizedEnrollment, EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { isFolderRepo } from '../../shared/repo-kind'
import { getAutomationSchedulerOwnerForExecutionHost } from '../persistence/scheduling-automations/automation-context-migration'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeGitTarget } from '../runtime/runtime-git-command-target'
import type { ResolvedRuntimeFileTarget } from '../runtime/runtime-file-command-target'
import {
  createEnrollmentWorktree,
  enrollmentWorktreeRollback
} from '../fork-heimdall/enrollment-worktree'

export const HOST_PIPELINE_NODE_TYPES: ReadonlySet<NodeType> = new Set([
  'agent',
  'check',
  'script',
  'decision',
  'loop',
  'swarm',
  'merge',
  'gate',
  'land',
  'objective',
  'pr-sitter'
])

export type PipelineKindAuthorizationDependencies = Readonly<{
  runtime: OrcaRuntimeService
  store: Store
  storageAuthority: 'desktop' | 'runtime'
  hostNodeTypes?: ReadonlySet<NodeType>
}>

type PipelineWorkspaceResolver = Readonly<{
  resolveRuntimeGitTarget(selector: string): Promise<RuntimeGitTarget>
  resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget>
}>

type PipelineAuthorizedWorkspace = Readonly<{
  kind: 'git' | 'folder'
  executionHostId: ExecutionHostId
  workspacePath: string
  worktreeId: string | null
}>

export class PipelineOwnerNotExecutableError extends Error {
  readonly schedulerOwner: AutomationSchedulerOwner

  constructor(schedulerOwner: AutomationSchedulerOwner) {
    super(`Pipeline watcher owner is not executable: ${schedulerOwner}`)
    this.name = 'PipelineOwnerNotExecutableError'
    this.schedulerOwner = schedulerOwner
  }
}

function schedulerOwnerFor(
  executionHostId: ExecutionHostId,
  storageAuthority: 'desktop' | 'runtime'
): AutomationSchedulerOwner {
  const owner = getAutomationSchedulerOwnerForExecutionHost(executionHostId)
  if (
    (storageAuthority === 'desktop' && owner === 'remote_host_service') ||
    (storageAuthority === 'runtime' && owner !== 'local_host_service')
  ) {
    throw new PipelineOwnerNotExecutableError(owner)
  }
  return storageAuthority === 'runtime' ? 'remote_host_service' : owner
}

function parseCandidate(input: EnrollInput): PipelineEnrollmentRequest {
  if (input.kind !== 'pipeline') {
    throw new Error('Pipeline enrollment requires the pipeline kind')
  }
  const parsed = PipelineEnrollmentRequestSchema.safeParse(input.kindPayload)
  if (!parsed.success) {
    throw new Error(`kindPayload: ${parsed.error.message}`)
  }
  return parsed.data
}

function validateCapabilityGrants(input: EnrollInput): Record<string, 'off' | 'gated' | 'on'> {
  const grants: Record<string, 'off' | 'gated' | 'on'> = {}
  for (const [key, mode] of Object.entries(input.capabilities)) {
    if (key === 'gate' || key === 'pipeline') {
      throw new Error(`engine capability supplied by client: ${key}`)
    }
    if (!PIPELINE_CAPABILITY_KEYS.some((known) => known === key)) {
      throw new Error(`capability key not allowed: ${key}`)
    }
    grants[key] = mode
  }
  return { ...grants, gate: 'on', pipeline: 'on' }
}

function inputValueMatches(type: 'text' | 'number' | 'boolean', value: unknown): boolean {
  if (type === 'text') {
    return typeof value === 'string'
  }
  if (type === 'number') {
    return typeof value === 'number' && Number.isFinite(value)
  }
  return typeof value === 'boolean'
}

function validateRunInputs(
  document: PipelineDocument,
  input: Readonly<Record<string, string | number | boolean>>
): Record<string, string | number | boolean> {
  const definitions = document.inputs ?? { task: { type: 'text' as const, required: true } }
  for (const name of Object.keys(input)) {
    if (!Object.hasOwn(definitions, name)) {
      throw new Error(`runInputs: unknown input ${name}`)
    }
  }
  const result: Record<string, string | number | boolean> = { ...input }
  for (const [name, definition] of Object.entries(definitions)) {
    if (Object.hasOwn(input, name)) {
      if (!inputValueMatches(definition.type, input[name])) {
        throw new Error(`runInputs: input ${name} must be ${definition.type}`)
      }
      continue
    }
    if (definition.default !== undefined) {
      if (!inputValueMatches(definition.type, definition.default)) {
        throw new Error(`runInputs: default for ${name} must be ${definition.type}`)
      }
      result[name] = definition.default
      continue
    }
    if (definition.required) {
      throw new Error(`runInputs: missing required input ${name}`)
    }
  }
  return result
}

function validationFailure(errors: readonly PipelineValidationError[]): Error {
  const codes = [...new Set(errors.map((error) => error.code))]
  return new Error(`validation failed: ${codes.join(',')}\n${JSON.stringify(errors)}`)
}

function validatePinnedSource(candidate: PipelineEnrollmentPayload): void {
  const documentHash = pipelineContentHash(candidate.document)
  if (
    candidate.pin.id !== candidate.document.id ||
    candidate.pin.documentVersion !== candidate.document.version ||
    documentHash !== candidate.pin.contentHash
  ) {
    throw new Error('contentHash mismatch')
  }
  const parsedSource = parsePipelineText(candidate.sourceText)
  if (parsedSource.document === null) {
    throw new Error(`sourceText parse failed: ${JSON.stringify(parsedSource.errors)}`)
  }
  if (pipelineContentHash(parsedSource.document) !== documentHash) {
    throw new Error('sourceText/document mismatch')
  }
  const ref = parsePipelineRef(candidate.pin.ref)
  if (
    'error' in ref ||
    !('id' in ref) ||
    ref.scope !== candidate.pin.scope ||
    ref.id !== candidate.pin.id
  ) {
    throw new Error('pin ref does not match its scope and id')
  }
  if (candidate.pin.scope === 'builtin') {
    throw new Error('custom pipeline enrollment cannot use a built-in pin')
  }
  if (routeEnrollmentKind(candidate.document) !== 'pipeline') {
    throw new Error('Pipeline document routes to a built-in watcher kind')
  }
}

async function resolveWorkspace(
  input: EnrollInput,
  request: PipelineEnrollmentRequest,
  dependencies: PipelineKindAuthorizationDependencies,
  scope: EnrollmentAuthorizationScope | undefined,
  captureRollback: (rollback: () => Promise<void>) => void
): Promise<PipelineAuthorizedWorkspace> {
  // SAFETY: these host-authoritative resolvers are installed on OrcaRuntimeService's prototype but are not exposed by its IPC-facing exported surface.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveRuntimeGitTarget and resolveRuntimeFileTarget are runtime methods used by the established Objective authorization path.
  const resolver = dependencies.runtime as unknown as PipelineWorkspaceResolver
  const selectedWorkspace = input.worktreeId === null ? null : parseWorkspaceKey(input.worktreeId)
  const folderWorktreeId = selectedWorkspace?.type === 'folder' ? input.worktreeId : null
  const repo = dependencies.store.getRepo(input.repoId)

  if (request.newWorktree !== undefined) {
    if (folderWorktreeId !== null || (repo !== null && repo !== undefined && isFolderRepo(repo))) {
      throw new Error('New pipeline worktree requires a Git repository')
    }
    if (input.worktreeId !== null) {
      throw new Error('New pipeline worktree cannot name an existing worktree')
    }
    if (!request.newWorktree.name.trim()) {
      throw new Error('New pipeline worktree requires a name')
    }
    if (repo === null || repo === undefined) {
      throw new Error('Pipeline repository is unavailable')
    }
    schedulerOwnerFor(getRepoExecutionHostId(repo), dependencies.storageAuthority)
  }

  let rollbackCreatedWorktree: (() => Promise<void>) | null = null
  try {
    if (folderWorktreeId !== null) {
      const target = await resolver.resolveRuntimeFileTarget(`id:${folderWorktreeId}`)
      if (
        target.worktree.id !== folderWorktreeId ||
        target.worktree.repoId !== input.repoId ||
        !target.worktree.path
      ) {
        throw new Error('Invalid pipeline folder workspace identity')
      }
      return {
        kind: 'folder',
        executionHostId: target.executionHostId,
        workspacePath: target.worktree.path,
        worktreeId: folderWorktreeId
      }
    }

    if (repo && isFolderRepo(repo)) {
      if (input.worktreeId !== null) {
        throw new Error('Folder pipeline enrollment cannot name a Git worktree')
      }
      const target = await resolver.resolveRuntimeFileTarget(`id:${repo.id}::${repo.path}`)
      if (target.worktree.repoId !== repo.id || target.worktree.path !== repo.path) {
        throw new Error('Invalid pipeline folder workspace identity')
      }
      return {
        kind: 'folder',
        executionHostId: target.executionHostId,
        workspacePath: target.worktree.path,
        worktreeId: null
      }
    }

    if (!repo) {
      throw new Error('Pipeline repository is unavailable')
    }
    let worktreeId = input.worktreeId
    if (request.newWorktree !== undefined) {
      const created = await createEnrollmentWorktree(
        dependencies.runtime,
        repo,
        request.newWorktree,
        { label: 'Pipeline', diagnosticPrefix: 'Pipeline' }
      )
      worktreeId = created.worktree.id
      rollbackCreatedWorktree = enrollmentWorktreeRollback(
        dependencies.runtime,
        worktreeId,
        getRepoExecutionHostId(repo),
        'Pipeline'
      )
      captureRollback(rollbackCreatedWorktree)
      scope?.onAbandoned(rollbackCreatedWorktree)
    }
    if (worktreeId === null) {
      throw new Error('Git pipeline enrollment requires an explicit worktree')
    }
    const target = await resolver.resolveRuntimeGitTarget(`id:${worktreeId}`)
    if (
      target.worktree.id !== worktreeId ||
      target.worktree.repoId !== repo.id ||
      !target.worktree.path
    ) {
      throw new Error('Invalid pipeline Git workspace identity')
    }
    if (target.worktree.git.isBare || target.worktree.git.prunable) {
      throw new Error('Pipeline Git workspace is unavailable')
    }
    return {
      kind: 'git',
      executionHostId: target.executionHostId,
      workspacePath: target.worktree.path,
      worktreeId
    }
  } catch (error) {
    await rollbackCreatedWorktree?.()
    throw error
  }
}

/** Rebuilds pipeline payload and workspace authority from the parsed request and host state. */
export async function authorizePipelineEnrollment(
  dependencies: PipelineKindAuthorizationDependencies,
  input: EnrollInput,
  scope?: EnrollmentAuthorizationScope
): Promise<AuthorizedEnrollment> {
  const request = parseCandidate(input)
  const grants = validateCapabilityGrants(input)
  validatePinnedSource(request)
  const runInputs = validateRunInputs(request.document, request.runInputs)
  const rollbackCreatedWorktree: { current: (() => Promise<void>) | null } = { current: null }
  try {
    const workspace = await resolveWorkspace(input, request, dependencies, scope, (rollback) => {
      rollbackCreatedWorktree.current = rollback
    })
    const errors = validatePipeline(request.document, {
      workspaceKind: workspace.kind,
      hostNodeTypes: dependencies.hostNodeTypes ?? HOST_PIPELINE_NODE_TYPES,
      expectedId: request.pin.id
    })
    if (errors.length > 0) {
      throw validationFailure(errors)
    }
    const owner = schedulerOwnerFor(workspace.executionHostId, dependencies.storageAuthority)
    const kindPayload = PipelineEnrollmentPayloadSchema.parse({
      schemaVersion: request.schemaVersion,
      pin: request.pin,
      document: request.document,
      sourceText: request.sourceText,
      runInputs,
      workspaceKind: workspace.kind
    })
    return {
      kind: 'pipeline',
      workspaceKey: `${workspace.executionHostId}::${workspace.workspacePath}`,
      executionHostId: workspace.executionHostId,
      repoId: input.repoId,
      worktreeId: workspace.worktreeId,
      workspacePath: workspace.workspacePath,
      schedulerOwner: owner,
      capabilities: grants,
      budget: structuredClone(input.budget),
      kindPayload
    }
  } catch (error) {
    await rollbackCreatedWorktree.current?.()
    throw error
  }
}

/** Prevents a custom run from changing its source or form inputs when a watcher is re-armed. */
export function validatePipelineEnrollmentRearm(
  candidate: AuthorizedEnrollment,
  existing: { kind: string; kindPayload: unknown } | null
): void {
  if (candidate.kind !== 'pipeline' || existing === null) {
    return
  }
  if (existing.kind !== 'pipeline') {
    throw new Error('A custom pipeline watcher cannot change enrollment kind')
  }
  const previous = PipelineEnrollmentPayloadSchema.safeParse(existing.kindPayload)
  const next = PipelineEnrollmentPayloadSchema.safeParse(candidate.kindPayload)
  if (!previous.success || !next.success) {
    throw new Error('A custom pipeline watcher has an invalid saved payload')
  }
  if (
    !isDeepStrictEqual(previous.data.pin, next.data.pin) ||
    !isDeepStrictEqual(previous.data.document, next.data.document) ||
    previous.data.sourceText !== next.data.sourceText ||
    !isDeepStrictEqual(previous.data.runInputs, next.data.runInputs)
  ) {
    throw new Error(
      'A custom pipeline watcher cannot change its pinned document, source or run inputs'
    )
  }
}
