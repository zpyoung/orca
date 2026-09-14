import type { ApprovalScope } from '../../shared/fork-heimdall/gate'
import type { KernelAction, WatcherKind } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type {
  EnrollInput,
  EnrollResult,
  WatcherListEntry
} from '../../shared/fork-heimdall/watcher-types'
import type { HeimdallDebugReport } from './debug-report'

export type HeimdallKernelService = {
  registerKind<TWorld, TAction extends KernelAction, TResult>(
    kind: WatcherKind<TWorld, TAction, TResult>
  ): void
  enroll(input: EnrollInput): Promise<EnrollResult>
  list(): Promise<WatcherListEntry[]>
  disarm(watcherId: string): Promise<void>
  disarmAll(): Promise<void>
  approve(watcherId: string, scope: ApprovalScope): Promise<void>
  ledger(watcherId: string): WatcherLedger
  debugReport(watcherId: string): HeimdallDebugReport
  suspend(): void
  resume(): void
  stopForShutdown(): void
}
