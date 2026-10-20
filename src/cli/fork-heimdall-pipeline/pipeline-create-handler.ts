import { isAbsolute, relative, resolve, sep } from 'node:path'
import { HEIMDALL_CHANNELS, type EnrollSuccess } from '../../shared/fork-heimdall/api'
import {
  HEIMDALL_ENROLL_OWNER_RUNTIME_CAPABILITY,
  HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY,
  HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_UPDATE_REQUIRED_MESSAGE,
  HEIMDALL_HOSTED_REVIEW_DERIVED_PAYLOAD_RUNTIME_CAPABILITY,
  HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY
} from '../../shared/fork-heimdall/capability'
import { EnrollInputSchema, type EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import type { WatcherTarget } from '../../shared/fork-heimdall/fleet-types'
import {
  ObjectiveEnrollmentPayloadSchema,
  OBJECTIVE_CAPABILITY_KEYS,
  ObjectiveCapabilitiesSchema,
  objectiveCapabilityModes
} from '../../shared/fork-heimdall-objective/contract-types'
import { HostedReviewEnrollmentCandidateSchema } from '../../shared/fork-hosted-review-sitter'
import {
  defaultGrants,
  PIPELINE_USER_CAPABILITY_KEYS,
  requestedCapabilities
} from '../../shared/fork-heimdall-pipeline/capability-grants'
import {
  HEIMDALL_PIPELINE_RUNTIME_CAPABILITY,
  hostPipelineNodeTypes
} from '../../shared/fork-heimdall-pipeline/capability'
import { PipelineEnrollmentPayloadSchema } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import {
  objectiveKindPayloadFromDocument,
  routeEnrollmentKind,
  sitterKindPayloadFromDocument
} from '../../shared/fork-heimdall-pipeline/enrollment-routing'
import type { PipelineRef } from '../../shared/fork-heimdall-pipeline/pipeline-ref'
import { parsePipelineRef } from '../../shared/fork-heimdall-pipeline/pipeline-ref'
import { PipelinePinSchema } from '../../shared/fork-heimdall-pipeline/pipeline-pin'
import { pipelineContentHash } from '../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { parsePipelineText } from '../../shared/fork-heimdall-pipeline/pipeline-parse'
import { validatePipeline } from '../../shared/fork-heimdall-pipeline/pipeline-validate'
import type { PipelineValidationError } from '../../shared/fork-heimdall-pipeline/pipeline-validate'
import type {
  PipelineResolveResponse,
  PipelineRunViewResponse
} from '../../shared/fork-heimdall-pipeline/rpc-schemas'
import { WatcherOwnerConfigSchema } from '../../shared/fork-heimdall/owner/owner-config'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { formatGroupHelp } from '../help'
import { COMMAND_SPECS } from '../specs'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import {
  HEIMDALL_HOSTED_REVIEW_CAPABILITY_NAMES,
  HeimdallHostedReviewCapabilitiesSchema,
  parseCapabilityFlags,
  parseHeimdalCreateBudgetOverrides
} from '../fork-heimdall/create-flag-values'
import { parseHeimdallCreateSchema } from '../fork-heimdall/create-input-validation'
import type { HeimdallCreateWorkspace } from '../fork-heimdall/create-input'
import { resolveHeimdallWorkspaceSelector } from '../fork-heimdall/watcher-row'
import { buildPipelineRunInputs } from './pipeline-create-spec'

const DEFAULT_PIPELINE_BUDGET = { wallClockActiveMs: 14_400_000, turns: 40 } as const
const DEFAULT_HOSTED_REVIEW_BUDGET = { wallClockActiveMs: 14_400_000, turns: null } as const

function createReference(
  text: string,
  workspacePath: string
): { ref: string; parsed: PipelineRef } {
  let ref = text
  if (isAbsolute(text)) {
    const workspaceRoot = resolve(workspacePath)
    const relativePath = relative(workspaceRoot, resolve(text))
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new RuntimeClientError(
        'invalid_argument',
        '--pipeline path must be inside the selected worktree.'
      )
    }
    ref = relativePath.split(sep).join('/')
  }
  const parsed = parsePipelineRef(ref)
  if ('error' in parsed) {
    throw new RuntimeClientError('invalid_argument', parsed.error)
  }
  return { ref, parsed }
}

function resolvedIdentityMatches(
  requested: PipelineRef,
  response: PipelineResolveResponse
): boolean {
  const expectedScope = requested.scope === 'path' ? 'repo' : requested.scope
  const expectedId =
    requested.scope === 'path'
      ? requested.path.slice(requested.path.lastIndexOf('/') + 1, -'.yaml'.length)
      : requested.id
  const expectedRef = expectedScope === 'repo' ? expectedId : `${expectedScope}:${expectedId}`
  return (
    response.scope === expectedScope && response.id === expectedId && response.ref === expectedRef
  )
}

function validationErrorMessage(errors: readonly PipelineValidationError[]): string {
  return errors.map((error) => `${error.nodeId ?? '-'} ${error.code}: ${error.message}`).join('\n')
}

function ownerFields(flags: Map<string, string | boolean>, capabilities: readonly string[]) {
  const owner = getOptionalStringFlag(flags, 'owner')
  const model = getOptionalStringFlag(flags, 'owner-model')
  const effort = getOptionalStringFlag(flags, 'owner-effort')
  if (owner !== undefined && owner !== 'claude') {
    throw new RuntimeClientError('invalid_argument', '--owner currently supports only claude.')
  }
  if (owner === undefined && (model !== undefined || effort !== undefined)) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--owner-model and --owner-effort require --owner claude.'
    )
  }
  if (owner === undefined) {
    return {}
  }
  if (!capabilities.includes(HEIMDALL_ENROLL_OWNER_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'The selected runtime does not support Heimdall owner enrollment. Update or restart Orca, or retry without --owner.'
    )
  }
  return {
    owner: parseHeimdallCreateSchema(
      WatcherOwnerConfigSchema,
      {
        agent: owner,
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort })
      },
      'owner'
    ),
    ownerInterventionCapability: 'gated' as const
  }
}

function buildBudget(flags: Map<string, string | boolean>, hostedReview: boolean) {
  return {
    ...(hostedReview ? DEFAULT_HOSTED_REVIEW_BUDGET : DEFAULT_PIPELINE_BUDGET),
    ...parseHeimdalCreateBudgetOverrides(flags)
  }
}
type PipelineWorkspaceResolver = (
  context: HandlerContext,
  selector: string
) => Promise<HeimdallCreateWorkspace & { path: string }>

export function createPipelineCreateHandler(
  resolveWorkspace: PipelineWorkspaceResolver
): CommandHandler {
  return async (context) => {
    const pipelineText = getOptionalStringFlag(context.flags, 'pipeline')
    if (pipelineText === undefined) {
      console.log(formatGroupHelp(COMMAND_SPECS, ['heimdall', 'create']))
      return
    }

    const status = await context.client.call<RuntimeStatus>('status.get')
    const runtimeCapabilities = status.result.capabilities ?? []
    const hostLabel = status.result.machineName?.trim() || 'this host'
    if (!runtimeCapabilities.includes(HEIMDALL_PIPELINE_RUNTIME_CAPABILITY)) {
      throw new RuntimeClientError(
        'incompatible_runtime',
        'The owning runtime does not support Heimdall pipelines. Update the host and try again.'
      )
    }

    const requestedWorkspace = getOptionalStringFlag(context.flags, 'worktree') ?? 'active'
    const selector = await resolveHeimdallWorkspaceSelector(
      requestedWorkspace,
      context.cwd,
      context.client
    )
    const workspace = await resolveWorkspace(context, selector)
    const requestedRef = createReference(pipelineText, workspace.path)
    const resolved = await context.client.call<PipelineResolveResponse>(
      HEIMDALL_CHANNELS.pipelineResolve,
      {
        workspace: { repoId: workspace.repoId, worktreeId: workspace.worktreeId },
        ref: requestedRef.ref
      }
    )
    if (!resolvedIdentityMatches(requestedRef.parsed, resolved.result)) {
      throw new RuntimeClientError(
        'invalid_response',
        'The resolved pipeline identity does not match the requested reference.'
      )
    }

    const parsed = parsePipelineText(resolved.result.sourceText)
    const errors =
      parsed.document === null
        ? parsed.errors
        : validatePipeline(parsed.document, {
            workspaceKind: workspace.workspaceKind,
            hostNodeTypes: hostPipelineNodeTypes(runtimeCapabilities),
            hostLabel,
            expectedId: resolved.result.id
          })
    if (errors.length > 0 || parsed.document === null) {
      const message = validationErrorMessage(errors)
      throw new RuntimeClientError('invalid_argument', message, { errors })
    }
    const document = parsed.document
    const contentHash = pipelineContentHash(document)
    if (resolved.result.contentHash !== contentHash) {
      throw new RuntimeClientError(
        'invalid_response',
        'The resolved pipeline content hash does not match its source.'
      )
    }
    const pin = PipelinePinSchema.parse({
      ref: resolved.result.ref,
      scope: resolved.result.scope,
      id: resolved.result.id,
      contentHash,
      documentVersion: 1
    })
    const runInputs = buildPipelineRunInputs(context.flags, document)
    const routedKind = routeEnrollmentKind(document)
    const owner = ownerFields(context.flags, runtimeCapabilities)
    const workspaceFields = { repoId: workspace.repoId, worktreeId: workspace.worktreeId }
    const pipelineCopy =
      resolved.result.scope === 'builtin'
        ? { pipelinePin: pin }
        : { pipelinePin: pin, pipelineSource: { sourceText: resolved.result.sourceText } }
    let input: EnrollInput

    if (routedKind === 'objective') {
      const kindPayload = parseHeimdallCreateSchema(
        ObjectiveEnrollmentPayloadSchema,
        objectiveKindPayloadFromDocument(document, {
          objectiveText: getRequiredStringFlag(context.flags, 'spec'),
          workspaceKind: workspace.workspaceKind
        }),
        'kindPayload'
      )
      if (
        (kindPayload.gates?.length ?? 0) > 0 &&
        !runtimeCapabilities.includes(HEIMDALL_PARALLEL_EXECUTION_RUNTIME_CAPABILITY)
      ) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'The selected runtime does not support objective gates. Update or restart Orca before creating this pipeline.'
        )
      }
      if (
        (kindPayload.landingBar === 'hosted-review' || kindPayload.landingBar === 'merged') &&
        !runtimeCapabilities.includes(HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY)
      ) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_UPDATE_REQUIRED_MESSAGE
        )
      }
      const capOverrides = parseCapabilityFlags(
        context.flags,
        OBJECTIVE_CAPABILITY_KEYS,
        'objective'
      )
      const capabilities = parseHeimdallCreateSchema(
        ObjectiveCapabilitiesSchema,
        { ...objectiveCapabilityModes(kindPayload.landingBar), ...capOverrides },
        'capabilities'
      )
      input = parseHeimdallCreateSchema(
        EnrollInputSchema,
        {
          kind: 'objective',
          ...workspaceFields,
          capabilities,
          budget: buildBudget(context.flags, false),
          kindPayload,
          ...pipelineCopy,
          ...owner
        },
        'input'
      )
    } else if (routedKind === 'hosted-review') {
      if (
        !runtimeCapabilities.includes(HEIMDALL_HOSTED_REVIEW_DERIVED_PAYLOAD_RUNTIME_CAPABILITY)
      ) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          'The selected runtime does not support host-derived hosted-review enrollment. Update or restart Orca before creating this pipeline.'
        )
      }
      const kindPayload = parseHeimdallCreateSchema(
        HostedReviewEnrollmentCandidateSchema,
        sitterKindPayloadFromDocument(document),
        'kindPayload'
      )
      if (
        !runtimeCapabilities.includes(HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_RUNTIME_CAPABILITY) &&
        kindPayload.mergeCheckScope !== 'required'
      ) {
        throw new RuntimeClientError(
          'incompatible_runtime',
          HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_UPDATE_REQUIRED_MESSAGE
        )
      }
      const grants = defaultGrants(requestedCapabilities(document))
      const capOverrides = parseCapabilityFlags(
        context.flags,
        HEIMDALL_HOSTED_REVIEW_CAPABILITY_NAMES,
        'hosted-review'
      )
      const capabilities = parseHeimdallCreateSchema(
        HeimdallHostedReviewCapabilitiesSchema,
        {
          ...Object.fromEntries(
            HEIMDALL_HOSTED_REVIEW_CAPABILITY_NAMES.map((key) => [key, grants[key] ?? 'off'])
          ),
          ...capOverrides
        },
        'capabilities'
      )
      input = parseHeimdallCreateSchema(
        EnrollInputSchema,
        {
          kind: 'hosted-review',
          ...workspaceFields,
          capabilities,
          budget: buildBudget(context.flags, true),
          kindPayload,
          ...pipelineCopy,
          ...owner
        },
        'input'
      )
    } else {
      const capOverrides = parseCapabilityFlags(
        context.flags,
        PIPELINE_USER_CAPABILITY_KEYS,
        'pipeline'
      )
      const kindPayload = parseHeimdallCreateSchema(
        PipelineEnrollmentPayloadSchema,
        {
          schemaVersion: 1,
          pin,
          document,
          sourceText: resolved.result.sourceText,
          runInputs,
          workspaceKind: workspace.workspaceKind
        },
        'kindPayload'
      )
      input = parseHeimdallCreateSchema(
        EnrollInputSchema,
        {
          kind: 'pipeline',
          ...workspaceFields,
          capabilities: { ...defaultGrants(requestedCapabilities(document)), ...capOverrides },
          budget: buildBudget(context.flags, false),
          kindPayload,
          ...owner
        },
        'input'
      )
    }

    const enrollment = await context.client.call<EnrollSuccess>(HEIMDALL_CHANNELS.enroll, {
      input,
      owner: null
    })
    const watcherId = enrollment.result.entry.enrollment.watcherId
    const target: WatcherTarget = { watcherId, connectionId: null, pairingRevision: null }
    const view = await context.client.call<PipelineRunViewResponse>(
      HEIMDALL_CHANNELS.pipelineRunView,
      {
        target
      }
    )
    const runNumber = view.result.pin.runNumber
    if (runNumber === null) {
      throw new RuntimeClientError(
        'invalid_response',
        'The enrolled pipeline run has no run number.'
      )
    }
    printResult(
      view,
      context.json,
      () =>
        `Heimdall pipeline ${resolved.result.ref} run #${runNumber} enrolled as watcher ${watcherId}.`
    )
  }
}
