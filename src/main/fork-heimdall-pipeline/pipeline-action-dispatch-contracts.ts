import type { EffectCertaintyResolution } from '../../shared/fork-heimdall/effect-certainty'
import type { GateVerdict } from '../../shared/fork-heimdall/gate'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type {
  AcceptedWorkerCompletionContext,
  ActionExecutor,
  KernelAction,
  PreflightContext,
  SubmissionAdapter
} from '../../shared/fork-heimdall/kind-contract'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { PipelineKindWorld, PipelineReadyWorld } from './pipeline-kind-read'
import type { PipelineCompositeActionAdapter } from './pipeline-kind'
import type { PipelineStore } from './pipeline-store'
import type { Store } from '../persistence'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { ObjectiveForgeAccess } from '../fork-heimdall-objective/objective-forge-access'
import type { ResolvePipelineAgentReportContext } from './agent-node-executor'

export const ALLOW: GateVerdict = { verdict: 'allow' }

export type PipelineActionDispatcherDependencies = Readonly<{
  runtime: OrcaRuntimeService
  store: Store
  pipelineStore: PipelineStore
  nowMs(): number
  forge?: ObjectiveForgeAccess
  compositeActions: PipelineCompositeActionAdapter
}>

export type PipelineActionDispatcher = Pick<
  ActionExecutor<PipelineKindWorld, KernelAction>,
  'execute' | 'resolveOutcome' | 'attemptExpectation'
> & {
  preflight(
    action: KernelAction,
    snapshot: Snapshot<PipelineKindWorld>,
    ledger: WatcherLedger,
    context: PreflightContext
  ): Promise<GateVerdict>
  resolveReportContext: ResolvePipelineAgentReportContext
  resolveAcceptedWorkerCompletion(
    completion: AcceptedWorkerCompletionContext
  ): Promise<EffectCertaintyResolution | null>
  submission: SubmissionAdapter<PipelineKindWorld>
}

export type PipelineActionDispatchContext = Readonly<{
  dependencies: PipelineActionDispatcherDependencies
  worlds: Map<string, PipelineReadyWorld>
  resolveReportContext: ResolvePipelineAgentReportContext
}>
