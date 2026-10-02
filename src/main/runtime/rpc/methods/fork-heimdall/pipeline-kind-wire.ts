import { HEIMDALL_PIPELINE_CLIENT_CAPABILITIES } from '../../../../../shared/fork-heimdall-pipeline/capability'
import type {
  HeimdallFleetSnapshotReader,
  WatcherDetailReader,
  WatcherListEntryReader
} from '../../../../../shared/fork-heimdall/remote-reader-schemas'
import type { RpcContext } from '../../core'

type PipelineKindWireContext = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>

export function clientReadsPipelineKind(context: PipelineKindWireContext): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(HEIMDALL_PIPELINE_CLIENT_CAPABILITIES[0]) === true
  )
}

export function projectPipelineFleetSnapshotForClient(
  snapshot: HeimdallFleetSnapshotReader,
  context: PipelineKindWireContext
): HeimdallFleetSnapshotReader {
  if (clientReadsPipelineKind(context)) {
    return snapshot
  }
  const entries = snapshot.entries.filter((entry) => {
    const kind = entry.entry.enrollment.kind
    return kind !== 'pipeline' && kind !== 'unknown'
  })
  return entries.length === snapshot.entries.length ? snapshot : { ...snapshot, entries }
}
export function projectPipelineListForClient<T extends WatcherListEntryReader>(
  entries: readonly T[],
  context: PipelineKindWireContext
): readonly T[] {
  return clientReadsPipelineKind(context)
    ? entries
    : entries.filter(
        (entry) => entry.enrollment.kind !== 'pipeline' && entry.enrollment.kind !== 'unknown'
      )
}

export function projectPipelineDetailForClient(
  detail: WatcherDetailReader,
  context: PipelineKindWireContext
): WatcherDetailReader {
  const kind = detail.watcher.entry.enrollment.kind
  if (!clientReadsPipelineKind(context) && (kind === 'pipeline' || kind === 'unknown')) {
    throw new Error('watcher-not-found')
  }
  return detail
}
