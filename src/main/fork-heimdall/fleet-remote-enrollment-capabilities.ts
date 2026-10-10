import {
  HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_UPDATE_REQUIRED_MESSAGE,
  HEIMDALL_OBJECTIVE_HOSTED_REVIEW_CHECK_SCOPE_UPDATE_REQUIRED_MESSAGE
} from '../../shared/fork-heimdall/capability'
import { HEIMDALL_PIPELINE_RUNTIME_CAPABILITY } from '../../shared/fork-heimdall-pipeline/capability'
import { PipelineEnrollmentPayloadSchema } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import type {
  NodeType,
  PipelineDocument
} from '../../shared/fork-heimdall-pipeline/document-schema'
import { validatePipeline } from '../../shared/fork-heimdall-pipeline/pipeline-validate'
import { parsePipelineText } from '../../shared/fork-heimdall-pipeline/pipeline-parse'
import type { EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import { HeimdallCommandCapabilityError } from './fleet-environment-transport'
import type { HeimdallCommandSupport } from './fleet-projection'
type PipelineHostSupport = {
  pipelineSupport: HeimdallCommandSupport
  pipelineNodeTypes: ReadonlySet<NodeType>
  hostLabel?: string | undefined
}

export class HeimdallPipelineHostRefusalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HeimdallPipelineHostRefusalError'
  }
}

function refuseUnsupportedPipelineNodeTypes(
  document: PipelineDocument,
  workspaceKind: 'git' | 'folder' | 'unknown',
  host: PipelineHostSupport
): void {
  const unsupportedType = validatePipeline(document, {
    workspaceKind,
    hostNodeTypes: host.pipelineNodeTypes,
    ...(host.hostLabel === undefined ? {} : { hostLabel: host.hostLabel })
  }).find((error) => error.code === 'node-type-unsupported-by-host')
  if (unsupportedType) {
    throw new HeimdallPipelineHostRefusalError(unsupportedType.message)
  }
}

export function enrollmentForPipelineCompatibility(
  input: EnrollInput,
  host: PipelineHostSupport
): EnrollInput {
  const sourceRequired =
    (input.kind === 'objective' || input.kind === 'hosted-review') &&
    input.pipelinePin !== undefined &&
    input.pipelinePin.scope !== 'builtin'
  if (sourceRequired && input.pipelineSource === undefined) {
    throw new Error('A source snapshot is required for a repo or personal pipeline pin.')
  }
  if (input.kind === 'pipeline' && input.pipelineSource !== undefined) {
    throw new Error('Custom pipeline source belongs in the pipeline kind payload.')
  }

  if (input.kind === 'pipeline') {
    if (host.pipelineSupport !== 'supported') {
      throw new HeimdallCommandCapabilityError(HEIMDALL_PIPELINE_RUNTIME_CAPABILITY)
    }
    const payload = PipelineEnrollmentPayloadSchema.safeParse(input.kindPayload)
    if (payload.success) {
      refuseUnsupportedPipelineNodeTypes(payload.data.document, payload.data.workspaceKind, host)
    }
    return input
  }

  if (input.pipelineSource !== undefined) {
    if (host.pipelineSupport !== 'supported') {
      throw new HeimdallCommandCapabilityError(HEIMDALL_PIPELINE_RUNTIME_CAPABILITY)
    }
    const parsedSource = parsePipelineText(input.pipelineSource.sourceText)
    if (parsedSource.document === null) {
      throw new Error(
        parsedSource.errors[0]?.message ?? 'The pipeline source snapshot could not be parsed.'
      )
    }
    refuseUnsupportedPipelineNodeTypes(parsedSource.document, 'unknown', host)
    return input
  }

  if (host.pipelineSupport === 'supported' || input.pipelinePin === undefined) {
    return input
  }
  const { pipelinePin: _pipelinePin, ...legacyInput } = input
  return legacyInput
}

/** Strips `roleLaunch` from an objective enrollment when the remote host has not negotiated it. */
export function enrollmentWithoutUnsupportedRoleLaunch(
  input: EnrollInput,
  roleLaunchSupported: boolean
): EnrollInput {
  if (
    roleLaunchSupported ||
    input.kind !== 'objective' ||
    typeof input.kindPayload !== 'object' ||
    input.kindPayload === null ||
    Array.isArray(input.kindPayload)
  ) {
    return input
  }
  if (!('roleLaunch' in input.kindPayload)) {
    return input
  }
  const { roleLaunch: _roleLaunch, ...legacyKindPayload } = input.kindPayload
  return { ...input, kindPayload: legacyKindPayload }
}

/** Only explicit `required` can degrade to a legacy host; missing scope means `all`. */
export function enrollmentForMergeCheckScopeCompatibility(
  input: EnrollInput,
  mergeCheckScopeSupport: HeimdallCommandSupport
): EnrollInput {
  const mergeCheckScopeSupported = mergeCheckScopeSupport === 'supported'
  if (
    typeof input.kindPayload !== 'object' ||
    input.kindPayload === null ||
    Array.isArray(input.kindPayload)
  ) {
    return input
  }

  if (input.kind === 'objective') {
    const landingBar = 'landingBar' in input.kindPayload ? input.kindPayload.landingBar : undefined
    const handoffNeedsHostedReview = landingBar === 'hosted-review' || landingBar === 'merged'
    if (!mergeCheckScopeSupported && handoffNeedsHostedReview) {
      throw new Error(HEIMDALL_OBJECTIVE_HOSTED_REVIEW_CHECK_SCOPE_UPDATE_REQUIRED_MESSAGE)
    }
    return input
  }

  if (input.kind !== 'hosted-review' || mergeCheckScopeSupported) {
    return input
  }
  if (
    !('mergeCheckScope' in input.kindPayload) ||
    input.kindPayload.mergeCheckScope !== 'required'
  ) {
    throw new Error(HEIMDALL_HOSTED_REVIEW_CHECK_SCOPE_UPDATE_REQUIRED_MESSAGE)
  }
  // stripping for a host that may be current would let its `all` default override the choice
  if (mergeCheckScopeSupport === 'unknown') {
    return input
  }

  const { mergeCheckScope: _mergeCheckScope, ...legacyKindPayload } = input.kindPayload
  return { ...input, kindPayload: legacyKindPayload }
}
