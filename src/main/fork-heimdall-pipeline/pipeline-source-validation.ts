import { isDeepStrictEqual } from 'node:util'
import {
  ObjectiveEnrollmentPayloadSchema,
  type ObjectiveWorkspaceKind
} from '../../shared/fork-heimdall-objective/contract-types'
import { HOSTED_REVIEW_DEFAULT_REPEAT_FIX_LIMIT } from '../../shared/fork-hosted-review-sitter/stop-policy'
import type { EnrollmentRecord } from '../fork-heimdall/enrollment-store'
import { parseHostedReviewEnrollmentPayload } from '../fork-hosted-review-sitter/definition-store'
import type {
  AuthorizedEnrollment,
  EnrollInput,
  EnrollResult
} from '../../shared/fork-heimdall/watcher-types'
import type { NodeType } from '../../shared/fork-heimdall-pipeline/document-schema'
import {
  PipelinePinSchema,
  type PipelinePin
} from '../../shared/fork-heimdall-pipeline/pipeline-pin'
import {
  PipelineSourceSnapshotSchema,
  type PipelineSourceSnapshot
} from '../../shared/fork-heimdall-pipeline/pipeline-source'
import {
  objectiveKindPayloadFromDocument,
  routeEnrollmentKind,
  sitterKindPayloadFromDocument
} from '../../shared/fork-heimdall-pipeline/enrollment-routing'
import { pipelineContentHash } from '../../shared/fork-heimdall-pipeline/pipeline-canonical-hash'
import { parsePipelineText } from '../../shared/fork-heimdall-pipeline/pipeline-parse'
import { validatePipeline } from '../../shared/fork-heimdall-pipeline/pipeline-validate'
import type { PipelineStore } from './pipeline-store'

type InvalidPayloadRefusal = Extract<EnrollResult, { status: 'refused' }> & {
  reason: 'invalid-payload'
}

export type PipelineSourceValidationResult = {
  refusal: InvalidPayloadRefusal | null
  source: PipelineSourceSnapshot | null
}

function refuseInvalidPipelineSource(detail: string): PipelineSourceValidationResult {
  return {
    refusal: { status: 'refused', reason: 'invalid-payload', detail },
    source: null
  }
}

export type ValidatePipelineEnrollmentSourceArgs = {
  input: EnrollInput
  authorized: AuthorizedEnrollment
  existing?: EnrollmentRecord | null
  pipelineStore: PipelineStore
  workspaceKind: ObjectiveWorkspaceKind
  hostNodeTypes?: ReadonlySet<NodeType>
}

/** Validates copied legacy-kind source snapshots without moving them into strict kind payloads. */
export function validatePipelineEnrollmentSource(
  args: ValidatePipelineEnrollmentSourceArgs
): PipelineSourceValidationResult {
  let incomingPin: PipelinePin | null = null
  if (args.input.pipelinePin !== undefined) {
    const parsedPin = PipelinePinSchema.safeParse(args.input.pipelinePin)
    if (!parsedPin.success) {
      return refuseInvalidPipelineSource('The pipeline pin is invalid')
    }
    incomingPin = parsedPin.data
  }

  let incomingSource: PipelineSourceSnapshot | null = null
  if (args.input.pipelineSource !== undefined) {
    const parsedSource = PipelineSourceSnapshotSchema.safeParse(args.input.pipelineSource)
    if (!parsedSource.success) {
      return refuseInvalidPipelineSource('The pipeline source snapshot is invalid')
    }
    incomingSource = parsedSource.data
  }

  let previousPin: (PipelinePin & { runNumber: number }) | null = null
  let previousSource: PipelineSourceSnapshot | null = null
  if (args.existing !== undefined && args.existing !== null) {
    try {
      previousPin = args.pipelineStore.runPin(args.existing.watcherId)
      previousSource = args.pipelineStore.runSource(args.existing.watcherId)
    } catch {
      return refuseInvalidPipelineSource('The saved pipeline pin or source snapshot is invalid')
    }

    if (previousSource !== null && previousPin === null) {
      return refuseInvalidPipelineSource('The saved pipeline source has no matching pin')
    }
    if (previousSource !== null && args.existing.kind === 'pipeline') {
      return refuseInvalidPipelineSource(
        'Custom pipeline enrollments cannot have a duplicate source snapshot'
      )
    }
    const savedCopyPin =
      previousPin !== null &&
      (previousPin.scope === 'repo' || previousPin.scope === 'user') &&
      args.existing.kind !== 'pipeline'
    if (savedCopyPin && previousSource === null) {
      return refuseInvalidPipelineSource('The saved copied pipeline has no source snapshot')
    }
    if (previousSource !== null) {
      if (args.existing.kind !== args.authorized.kind || args.input.kind !== args.existing.kind) {
        return refuseInvalidPipelineSource(
          'A source-pinned watcher cannot change its enrollment kind'
        )
      }
      if (
        incomingPin !== null &&
        previousPin !== null &&
        (incomingPin.ref !== previousPin.ref ||
          incomingPin.scope !== previousPin.scope ||
          incomingPin.id !== previousPin.id ||
          incomingPin.contentHash !== previousPin.contentHash ||
          incomingPin.documentVersion !== previousPin.documentVersion)
      ) {
        return refuseInvalidPipelineSource(
          'A source-pinned watcher cannot change its pipeline identity'
        )
      }
      if (incomingSource !== null && !isDeepStrictEqual(incomingSource, previousSource)) {
        return refuseInvalidPipelineSource(
          'A source-pinned watcher cannot replace its saved source snapshot'
        )
      }
      if ('malformedKindPayload' in args.existing) {
        return refuseInvalidPipelineSource(
          'A source-pinned watcher has an invalid saved kind payload'
        )
      }

      let previousKindPayload: unknown
      let authorizedKindPayload: unknown
      if (args.existing.kind === 'objective') {
        const previousPayload = ObjectiveEnrollmentPayloadSchema.safeParse(
          args.existing.kindPayload
        )
        const authorizedPayload = ObjectiveEnrollmentPayloadSchema.safeParse(
          args.authorized.kindPayload
        )
        if (!previousPayload.success || !authorizedPayload.success) {
          return refuseInvalidPipelineSource(
            'A source-pinned Objective watcher has an invalid kind payload'
          )
        }
        previousKindPayload = previousPayload.data
        authorizedKindPayload = authorizedPayload.data
      } else {
        const previousPayload = parseHostedReviewEnrollmentPayload(args.existing.kindPayload)
        const authorizedPayload = parseHostedReviewEnrollmentPayload(args.authorized.kindPayload)
        if (previousPayload === null || authorizedPayload === null) {
          return refuseInvalidPipelineSource(
            'A source-pinned PR-sitter watcher has an invalid kind payload'
          )
        }
        previousKindPayload = previousPayload
        authorizedKindPayload = authorizedPayload
      }
      if (!isDeepStrictEqual(previousKindPayload, authorizedKindPayload)) {
        return refuseInvalidPipelineSource('A source-pinned watcher cannot change its kind payload')
      }
    } else if (incomingSource !== null) {
      return refuseInvalidPipelineSource(
        'A re-armed watcher cannot acquire a new pipeline source snapshot'
      )
    }
  }

  const pin = incomingPin ?? previousPin
  const source = previousSource ?? incomingSource
  const legacyKind =
    args.authorized.kind === 'objective' || args.authorized.kind === 'hosted-review'
  const copiedLegacyPin =
    legacyKind && pin !== null && (pin.scope === 'repo' || pin.scope === 'user')
  if (copiedLegacyPin && source === null) {
    return refuseInvalidPipelineSource(
      'A copied Objective or PR-sitter pipeline requires its source snapshot'
    )
  }
  if (source === null) {
    return { refusal: null, source: null }
  }
  if (pin === null || !legacyKind || args.authorized.kind !== args.input.kind) {
    return refuseInvalidPipelineSource(
      'A pipeline source snapshot requires a matching legacy-kind pin'
    )
  }

  const parsed = parsePipelineText(source.sourceText)
  if (parsed.document === null) {
    return refuseInvalidPipelineSource('The pinned pipeline source cannot be parsed')
  }
  const document = parsed.document
  const errors = validatePipeline(document, {
    workspaceKind: args.workspaceKind,
    expectedId: pin.id,
    ...(args.hostNodeTypes === undefined ? {} : { hostNodeTypes: args.hostNodeTypes })
  })
  if (
    errors.length > 0 ||
    document.id !== pin.id ||
    document.version !== pin.documentVersion ||
    pipelineContentHash(document) !== pin.contentHash
  ) {
    return refuseInvalidPipelineSource(
      'The pinned pipeline source does not match its pin or host validation'
    )
  }

  const routedKind = routeEnrollmentKind(document)
  if (routedKind !== args.authorized.kind) {
    return refuseInvalidPipelineSource(
      'The pinned pipeline source routes to a different enrollment kind'
    )
  }

  if (args.authorized.kind === 'objective') {
    const payload = ObjectiveEnrollmentPayloadSchema.safeParse(args.authorized.kindPayload)
    if (!payload.success) {
      return refuseInvalidPipelineSource('The authorized Objective kind payload is invalid')
    }
    const expected = ObjectiveEnrollmentPayloadSchema.safeParse(
      objectiveKindPayloadFromDocument(document, {
        objectiveText: payload.data.objectiveText,
        workspaceKind: args.workspaceKind
      })
    )
    if (!expected.success || !isDeepStrictEqual(expected.data, payload.data)) {
      return refuseInvalidPipelineSource(
        'The authorized Objective settings do not match the pinned source'
      )
    }
  } else {
    const payload = parseHostedReviewEnrollmentPayload(args.authorized.kindPayload)
    if (payload === null) {
      return refuseInvalidPipelineSource('The authorized PR-sitter kind payload is invalid')
    }
    const expected = sitterKindPayloadFromDocument(document)
    const actualSettings = {
      branchUpdateMode: payload.branchUpdateMode,
      mergeMethod: payload.mergeMethod,
      mergeCheckScope: payload.mergeCheckScope,
      repeatFixLimit: payload.repeatFixLimit ?? HOSTED_REVIEW_DEFAULT_REPEAT_FIX_LIMIT
    }
    const expectedSettings = {
      ...expected,
      repeatFixLimit: expected.repeatFixLimit ?? HOSTED_REVIEW_DEFAULT_REPEAT_FIX_LIMIT
    }
    if (!isDeepStrictEqual(expectedSettings, actualSettings)) {
      return refuseInvalidPipelineSource(
        'The authorized PR-sitter settings do not match the pinned source'
      )
    }
  }

  return { refusal: null, source }
}
