import type {
  KernelAction,
  SubmissionPreflightResult,
  WatcherKind
} from '../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type {
  HeimdallFleetSnapshot,
  WatcherCommandRequest,
  WatcherCommandResult,
  WatcherDetail,
  WatcherTarget
} from '../../shared/fork-heimdall/fleet-types'
import type {
  EnrollInput,
  EnrollResult,
  WatcherListEntry
} from '../../shared/fork-heimdall/watcher-types'
import type { HeimdallDebugReport } from './debug-report'

export type HeimdallOrchestrationSubmission = Readonly<{
  runId: string
  dispatchId?: string
  from: string
  type: string
  subject: string
  body?: string
  payload?: string
}>

export type HeimdallKernelService = {
  registerKind<TWorld, TAction extends KernelAction, TResult>(
    kind: WatcherKind<TWorld, TAction, TResult>
  ): void
  enroll(input: EnrollInput): Promise<EnrollResult>
  list(): Promise<WatcherListEntry[]>
  fleet(): Promise<HeimdallFleetSnapshot>
  detail(target: WatcherTarget): Promise<WatcherDetail>
  command(request: WatcherCommandRequest): Promise<WatcherCommandResult>
  subscribe(listener: () => void): () => void
  ledger(watcherId: string): WatcherLedger
  debugReport(watcherId: string): Promise<HeimdallDebugReport>
  preflightSubmission(
    submission: HeimdallOrchestrationSubmission
  ): Promise<SubmissionPreflightResult>
  suspend(): void
  resume(): void
  start(): void
  onShutdown(listener: () => void, phase?: 'start' | 'drained'): () => void
  stopForShutdown(): Promise<void>
}
