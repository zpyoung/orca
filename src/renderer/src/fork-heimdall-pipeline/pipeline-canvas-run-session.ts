import type {
  WatcherCommand,
  WatcherCommandResult
} from '../../../shared/fork-heimdall/fleet-types'
import type {
  WatcherDetailReader,
  WatcherFleetEntryReader
} from '../../../shared/fork-heimdall/remote-reader-schemas'
import type { PipelineRunView } from '../../../shared/fork-heimdall-pipeline/run-view-types'
import type { ApprovalScope } from '../../../shared/fork-heimdall/ledger-types'
import type { HeimdallApi } from '../../../shared/fork-heimdall/api'
import { translate } from '@/i18n/i18n'
import { getObjectiveHeimdallApi } from '../fork-heimdall-objective/objective-heimdall-api'
import { loadPipelineRunView } from './pipeline-run-view-client'

export type PipelineCanvasRunOption = { watcherId: string; runNumber: number | null }
export type PipelineCanvasRunList = {
  options: PipelineCanvasRunOption[]
  rowsById: Readonly<Record<string, WatcherFleetEntryReader>>
}
export type PipelineCanvasRunDetail = {
  view: PipelineRunView
  row: WatcherFleetEntryReader
  ledger: WatcherDetailReader['ledger']
}

function liveWatcher(row: WatcherFleetEntryReader): boolean {
  return (
    row.entry.enrollment.terminalAtMs === null &&
    row.entry.status.enabled &&
    !row.paused &&
    row.entry.status.state !== 'disabled' &&
    row.entry.status.state !== 'terminal'
  )
}

type HeimdallPipelineListApi = HeimdallApi & {
  pipelineList: NonNullable<HeimdallApi['pipelineList']>
}

function hasPipelineList(api: HeimdallApi): api is HeimdallPipelineListApi {
  return typeof api.pipelineList === 'function'
}

function requirePipelineApi(api: HeimdallApi | null): HeimdallPipelineListApi {
  if (!api || !hasPipelineList(api)) {
    throw new Error(
      translate(
        'fork.heimdallPipeline.runGraph.unavailable',
        'Pinned pipeline run data is unavailable on this host.'
      )
    )
  }
  return api
}

/** Lists live pins for a workspace, resolving personal-run identities from the client-side fleet. */
export async function loadPipelineCanvasRuns(input: {
  repoId: string
  worktreeId: string
  scope: 'builtin' | 'repo' | 'user'
  id: string
}): Promise<PipelineCanvasRunList> {
  const api = requirePipelineApi(getObjectiveHeimdallApi())
  const ref =
    input.scope === 'user'
      ? `user:${input.id}`
      : input.scope === 'builtin'
        ? `builtin:${input.id}`
        : input.id
  const response = await api.pipelineList({
    workspace: { repoId: input.repoId, worktreeId: input.worktreeId }
  })
  const listed = response.pipelines.find((pipeline) => pipeline.ref === ref)
  const options = new Map<string, PipelineCanvasRunOption>()
  for (const run of listed?.liveRuns ?? []) {
    options.set(run.watcherId, { watcherId: run.watcherId, runNumber: run.runNumber })
  }

  const needsClientPinProjection = input.scope === 'user'
  if (options.size === 0 && !needsClientPinProjection) {
    return { options: [], rowsById: {} }
  }
  const snapshot = await api.fleet()
  const rows = snapshot.entries.filter(liveWatcher)
  const rowsById = Object.fromEntries(rows.map((row) => [row.target.watcherId, row]))
  if (needsClientPinProjection && typeof api.pipelineRunView === 'function') {
    const views = await Promise.all(
      rows.map(async (row) => {
        try {
          const view = await api.pipelineRunView?.(row.target)
          return view?.pin.ref === ref
            ? { watcherId: row.target.watcherId, runNumber: view.pin.runNumber }
            : null
        } catch {
          return null
        }
      })
    )
    for (const run of views) {
      if (run) {
        options.set(run.watcherId, run)
      }
    }
  }
  return {
    options: [...options.values()].sort(
      (left, right) => (right.runNumber ?? 0) - (left.runNumber ?? 0)
    ),
    rowsById
  }
}

/** Loads exactly the owner-selected watcher and refuses substituted or mismatched pins. */
export async function loadPipelineCanvasRunDetail(input: {
  row: WatcherFleetEntryReader
  ref: string
  scope: 'builtin' | 'repo' | 'user'
  id: string
}): Promise<PipelineCanvasRunDetail> {
  const api = getObjectiveHeimdallApi()
  if (!api) {
    throw new Error(
      translate(
        'fork.heimdallPipeline.runGraph.unavailable',
        'Pinned pipeline run data is unavailable on this host.'
      )
    )
  }
  const [view, detail] = await Promise.all([
    typeof api.pipelineRunView === 'function'
      ? api.pipelineRunView(input.row.target)
      : input.scope === 'builtin'
        ? loadPipelineRunView(input.row)
        : Promise.reject(
            new Error(
              translate(
                'fork.heimdallPipeline.runGraph.unavailable',
                'Pinned pipeline run data is unavailable on this host.'
              )
            )
          ),
    api.detail(input.row.target)
  ])
  if (
    view.watcherId !== input.row.target.watcherId ||
    view.pin.ref !== input.ref ||
    view.pin.scope !== input.scope ||
    view.pin.id !== input.id
  ) {
    throw new Error(
      translate(
        'fork.heimdallPipeline.runGraph.pinMismatch',
        'The selected run is pinned to a different pipeline source.'
      )
    )
  }
  return { view, row: input.row, ledger: detail.ledger }
}
export async function answerPipelineCanvasChoice(input: {
  row: WatcherFleetEntryReader
  command: Extract<WatcherCommand, { kind: 'answer-pipeline-choice' }>
}): Promise<WatcherCommandResult> {
  const api = getObjectiveHeimdallApi()
  if (!api) {
    throw new Error(
      translate(
        'fork.heimdallPipeline.runGraph.unavailable',
        'Heimdall control is unavailable in this client.'
      )
    )
  }
  return api.command({
    target: input.row.target,
    expectedOwner: input.row.ownerFence,
    command: { ...input.command, surface: 'canvas-run' }
  })
}
export async function approvePipelineCanvasAction(input: {
  row: WatcherFleetEntryReader
  scope: ApprovalScope
}): Promise<WatcherCommandResult> {
  const api = getObjectiveHeimdallApi()
  if (!api) {
    throw new Error(
      translate(
        'fork.heimdallPipeline.runGraph.unavailable',
        'Heimdall control is unavailable in this client.'
      )
    )
  }
  return api.command({
    target: input.row.target,
    expectedOwner: input.row.ownerFence,
    command: { kind: 'approve', scope: input.scope }
  })
}
