import {
  ObjectiveEnrollmentPayloadSchema,
  type ObjectiveWorkspaceKind
} from '../../shared/fork-heimdall-objective/contract-types'
import type {
  AuthorizedEnrollment,
  EnrollInput,
  EnrollResult,
  WatcherEnrollment
} from '../../shared/fork-heimdall/watcher-types'
import type { NodeType } from '../../shared/fork-heimdall-pipeline/document-schema'
import { PipelineEnrollmentPayloadSchema } from '../../shared/fork-heimdall-pipeline/enrollment-payload'
import { PipelinePinSchema } from '../../shared/fork-heimdall-pipeline/pipeline-pin'
import {
  PipelineSourceSnapshotSchema,
  type PipelineSourceSnapshot
} from '../../shared/fork-heimdall-pipeline/pipeline-source'
import { PipelineStore as PipelineStoreImpl, type PipelineStore } from './pipeline-store'
import { validatePipelineEnrollmentSource } from './pipeline-source-validation'
import type { KernelEnrollmentLifecycleDependencies } from '../fork-heimdall/kernel-enrollment-lifecycle'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { bindHeimdallPipeline, requireHeimdallPipeline } from './pipeline-binding'
import type { Store } from '../persistence'
import type { HeimdallKernelService } from '../fork-heimdall/kernel-service-contract'
import type { JudgmentPersistencePort } from '../fork-heimdall/judgment/store'
import { registerHostedReviewKind, type HostedReviewKind } from '../fork-hosted-review-sitter/kind'
import {
  registerObjectiveKind,
  type ObjectiveRegistration
} from '../fork-heimdall-objective/registration'
import { registerBuiltinPipelineKind } from './builtin-one-node-kind'
import { createPipelineKind } from './pipeline-kind'
import { PipelineDatabase } from './pipeline-database'
import { HOST_PIPELINE_NODE_TYPES } from './pipeline-kind-authorize'
import { createSitterCompositeAdapters } from './sitter-composite'

function pipelineBinding(runtime: OrcaRuntimeService) {
  try {
    return requireHeimdallPipeline(runtime)
  } catch {
    return null
  }
}

/** Wires pin validation before persistence and pin recording after a new row is inserted. */
export function pipelineEnrollmentHooks(
  runtime: OrcaRuntimeService
): Pick<KernelEnrollmentLifecycleDependencies, 'validatePipelineSource' | 'afterInsert'> {
  return {
    validatePipelineSource(input, authorized, existing) {
      const binding = pipelineBinding(runtime)
      if (!binding) {
        return input.kind !== 'pipeline' &&
          input.pipelinePin === undefined &&
          input.pipelineSource === undefined
          ? null
          : invalidPayload('Pipeline source validation is unavailable on this host')
      }
      return validateCopiedPipelineEnrollmentSource(
        input,
        authorized,
        existing,
        binding.pipelineStore
      )
    },
    afterInsert(inserted, input) {
      const binding = pipelineBinding(runtime)
      if (!binding) {
        if (
          input.kind === 'pipeline' ||
          input.pipelinePin !== undefined ||
          input.pipelineSource !== undefined
        ) {
          throw new Error('Pipeline run-pin storage is unavailable on this host')
        }
        return
      }
      recordPipelineRunPin(binding.pipelineStore, inserted, input)
    }
  }
}

export type PipelineSourceValidationRefusal = Extract<EnrollResult, { status: 'refused' }> & {
  reason: 'invalid-payload'
}

function invalidPayload(detail: string): PipelineSourceValidationRefusal {
  return { status: 'refused', reason: 'invalid-payload', detail }
}

/** Validates source-bearing legacy-kind candidates before the kernel writes or re-arms them. */
export function validateCopiedPipelineEnrollmentSource(
  input: EnrollInput,
  authorized: AuthorizedEnrollment,
  existing: WatcherEnrollment | null,
  pipelineStore: PipelineStore,
  hostNodeTypes: ReadonlySet<NodeType> = HOST_PIPELINE_NODE_TYPES
): PipelineSourceValidationRefusal | null {
  if (authorized.kind === 'hosted-review') {
    return validatePipelineEnrollmentSource({
      input,
      authorized,
      existing,
      pipelineStore,
      workspaceKind: 'git',
      hostNodeTypes
    }).refusal
  }
  if (authorized.kind !== 'objective') {
    return null
  }
  const payload = ObjectiveEnrollmentPayloadSchema.safeParse(authorized.kindPayload)
  if (!payload.success) {
    return invalidPayload('The authorized Objective kind payload is invalid')
  }
  const workspaceKind: ObjectiveWorkspaceKind = payload.data.workspaceKind
  return validatePipelineEnrollmentSource({
    input,
    authorized,
    existing,
    pipelineStore,
    workspaceKind,
    hostNodeTypes
  }).refusal
}

/** Records only successful-insert pins; re-arms retain the first run's source snapshot unchanged. */
export function recordPipelineRunPin(
  pipelineStore: PipelineStore,
  inserted: WatcherEnrollment,
  input: EnrollInput
): void {
  if (inserted.kind === 'pipeline') {
    const payload = PipelineEnrollmentPayloadSchema.parse(inserted.kindPayload)
    const source: PipelineSourceSnapshot = { sourceText: payload.sourceText }
    pipelineStore.recordRunPin(inserted.watcherId, payload.pin, inserted.createdAtMs, source)
    return
  }
  if (inserted.kind !== 'objective' && inserted.kind !== 'hosted-review') {
    return
  }
  if (input.pipelinePin === undefined) {
    return
  }
  const pin = PipelinePinSchema.parse(input.pipelinePin)
  const source =
    input.pipelineSource === undefined
      ? undefined
      : PipelineSourceSnapshotSchema.parse(input.pipelineSource)
  pipelineStore.recordRunPin(inserted.watcherId, pin, inserted.createdAtMs, source)
}
export type PipelineEngineRegistration = Readonly<{
  objective: ObjectiveRegistration
  dispose(): void
}>

/** Registers identity-mode built-ins and the custom pipeline kind on one shared set of stores. */
export function registerPipelineEngineKinds(
  kernel: HeimdallKernelService,
  runtime: OrcaRuntimeService,
  store: Store,
  storageAuthority: 'desktop' | 'runtime',
  judgment: JudgmentPersistencePort
): PipelineEngineRegistration {
  const pipelineDatabase = new PipelineDatabase(() => store.getProfileStorageDirectory())
  const pipelineStore = new PipelineStoreImpl(pipelineDatabase)
  const objective = registerObjectiveKind(
    {
      registerKind(kind) {
        registerBuiltinPipelineKind(kernel, 'objective', kind)
      }
    },
    runtime,
    store,
    storageAuthority,
    judgment
  )
  const capturedHostedReview: { kind?: HostedReviewKind } = {}
  registerHostedReviewKind(
    {
      registerKind(kind) {
        capturedHostedReview.kind = kind
        registerBuiltinPipelineKind(kernel, 'hosted-review', kind)
      }
    },
    runtime,
    store,
    storageAuthority
  )
  const hostedReviewKind = capturedHostedReview.kind
  if (hostedReviewKind === undefined) {
    throw new Error('The hosted-review kind did not register')
  }
  const adapters = createSitterCompositeAdapters({
    runtime,
    store,
    pipelineStore,
    hostedReviewKind,
    storageAuthority
  })
  kernel.registerKind(
    createPipelineKind({
      runtime,
      store,
      pipelineStore,
      storageAuthority,
      ...adapters
    })
  )
  bindHeimdallPipeline(runtime, { store, pipelineStore })
  let disposed = false
  return {
    objective,
    dispose() {
      if (!disposed) {
        disposed = true
        pipelineDatabase.close()
      }
    }
  }
}
