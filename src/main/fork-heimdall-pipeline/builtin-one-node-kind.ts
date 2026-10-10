import type { KernelAction, WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import { builtinPipelinePin } from '../../shared/fork-heimdall-pipeline/builtin-pipelines'
import type { PipelinePin } from '../../shared/fork-heimdall-pipeline/pipeline-pin'
import { createCompositeNodeHost } from './composite-node-host'

export type BuiltinPipelineKindId = 'objective' | 'hosted-review'

export type BuiltinPipelinePresentation<TWorld> = {
  pin: PipelinePin
  phase(snapshot: Snapshot<TWorld>, ledger: WatcherLedger): string
}

type BuiltinPipelineKind<
  TWorld,
  TAction extends KernelAction,
  TEnrollmentPayload = unknown
> = WatcherKind<TWorld, TAction, TEnrollmentPayload> & {
  pipelinePresentation: BuiltinPipelinePresentation<TWorld>
}

/** Registers a built-in kind without changing its runner-facing members or stored identity. */
export function registerBuiltinPipelineKind<
  TWorld,
  TAction extends KernelAction,
  TEnrollmentPayload
>(
  kernel: { registerKind(kind: WatcherKind<TWorld, TAction, TEnrollmentPayload>): void },
  id: BuiltinPipelineKindId,
  inner: WatcherKind<TWorld, TAction, TEnrollmentPayload>
): void {
  if (inner.id !== id) {
    throw new Error(`Built-in pipeline kind ${id} does not match inner kind ${inner.id}`)
  }
  const identityHost = createCompositeNodeHost(inner, { kind: 'identity' })
  const pipelinePresentation: BuiltinPipelinePresentation<TWorld> = {
    pin: builtinPipelinePin(id === 'objective' ? 'objective' : 'pr-sitter'),
    phase: identityHost.phase
  }
  const registeredKind: BuiltinPipelineKind<TWorld, TAction, TEnrollmentPayload> = {
    ...inner,
    pipelinePresentation
  }
  kernel.registerKind(registeredKind)
}
