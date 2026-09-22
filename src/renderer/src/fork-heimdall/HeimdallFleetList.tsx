import { Bot, Check, CircleHelp, Clock3, ListChecks, Play, WifiOff } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  LIST_TABLE_CONTAINER_CLASS,
  LIST_TABLE_HEADER_CLASS,
  LIST_TABLE_ROW_CLASS,
  LIST_TABLE_ROW_SELECTED_CLASS
} from '@/lib/list-table-layout'
import { ObjectiveEnrollmentPayloadSchema } from '../../../shared/fork-heimdall-objective/contract-types'
import type { WatcherFleetEntry, WatcherTarget } from '../../../shared/fork-heimdall/fleet-types'
import { formatHeimdallAge, formatHeimdallDuration } from './fleet-format'
import {
  resolveFleetActivity,
  resolveFleetWorkflowPhase,
  resolveFleetWorkspace
} from './fleet-row-presentation'
import { sameWatcherTarget } from './fleet-selectors'
import { HeimdallStatusPill } from './HeimdallStatusPill'

const GRID =
  'grid min-w-[1180px] grid-cols-[minmax(175px,1.25fr)_minmax(165px,1.2fr)_minmax(155px,1fr)_minmax(90px,0.65fr)_minmax(125px,0.9fr)_110px_52px_58px_82px]'

function ActiveBurn({ row }: { row: WatcherFleetEntry }): React.JSX.Element {
  const used = row.entry.status.budget.activeMs
  const limit = row.entry.enrollment.budget.wallClockActiveMs
  const percent = limit === null || limit === 0 ? null : Math.min(100, (used / limit) * 100)
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums">
        <span>{formatHeimdallDuration(used)}</span>
        <span className="text-muted-foreground">
          {limit === null
            ? translate('fork.heimdall.budget.unlimitedShort', 'unlimited')
            : formatHeimdallDuration(limit)}
        </span>
      </div>
      {percent !== null ? (
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div
            className={cn(
              'h-full rounded-full',
              percent >= 80 ? 'bg-status-warning' : 'bg-status-success'
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
      ) : null}
    </div>
  )
}

function workflowPhaseLabel(phase: string | null): string {
  switch (phase) {
    case 'planning':
      return translate('fork.heimdall.phase.planning', 'Planning')
    case 'implementation':
    case 'implementing':
      return translate('fork.heimdall.phase.implementing', 'Implementing')
    case 'checks':
      return translate('fork.heimdall.phase.checking', 'Checking')
    case 'review':
    case 'reviewing':
      return translate('fork.heimdall.phase.reviewing', 'Reviewing')
    case 'landing':
      return translate('fork.heimdall.phase.landing', 'Landing')
    case 'landed':
      return translate('fork.heimdall.phase.landed', 'Landed')
    case null:
      return translate('fork.heimdall.phase.unavailable', 'Phase unavailable')
    default: {
      const readable = phase.replace(/[-_]+/g, ' ')
      return `${readable.charAt(0).toUpperCase()}${readable.slice(1)}`
    }
  }
}

function ActivityIndicator({
  row,
  asOfMs
}: {
  row: WatcherFleetEntry
  asOfMs: number
}): React.JSX.Element {
  const activity = resolveFleetActivity(row)
  const parsedObjectivePayload =
    row.entry.enrollment.kind === 'objective'
      ? ObjectiveEnrollmentPayloadSchema.safeParse(row.entry.enrollment.kindPayload)
      : null
  const objectivePayload = parsedObjectivePayload?.success ? parsedObjectivePayload.data : null
  const objectiveConcurrency =
    row.parallel?.effectiveMaxConcurrency ??
    (objectivePayload === null
      ? null
      : objectivePayload.workspaceKind === 'folder'
        ? 1
        : objectivePayload.maxConcurrency)
  const objectiveRunningCount =
    row.parallel?.effectiveMaxConcurrency === 1 && activity.kind === 'agent-in-flight'
      ? Math.max(row.parallel.runningCount, activity.count)
      : (row.parallel?.runningCount ?? 0)
  if (activity.kind === 'unverifiable') {
    const detail = translate('fork.heimdall.activity.lastConfirmed', 'Last confirmed {{age}}', {
      age: formatHeimdallAge(activity.lastConfirmedAtMs, asOfMs)
    })
    return (
      <span className="flex min-w-0 items-start gap-1.5 text-status-warning" title={detail}>
        <WifiOff className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium">
            {translate('fork.heimdall.activity.unverifiable', 'Contact unverifiable')}
          </span>
          <span className="block truncate text-[11px]">{detail}</span>
        </span>
      </span>
    )
  }
  if (activity.kind === 'unknown') {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <CircleHelp className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate text-xs">
          {translate('fork.heimdall.activity.unavailable', 'Activity unavailable')}
        </span>
      </span>
    )
  }
  if (activity.kind === 'waiting') {
    const waiting = row.entry.status.state === 'watching'
    return (
      <span className="flex min-w-0 items-start gap-1.5 text-muted-foreground">
        <Clock3 className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0">
          <span className="block truncate text-xs">
            {objectiveConcurrency === null
              ? waiting
                ? translate('fork.heimdall.activity.waiting', 'Waiting for change')
                : translate('fork.heimdall.activity.inactive', 'No active work')
              : translate(
                  'fork.heimdall.activity.objectiveConcurrencyRunning',
                  '{{count}} of {{cap}} running',
                  { count: objectiveRunningCount, cap: objectiveConcurrency }
                )}
          </span>
          {row.parallel?.note ? (
            <span className="block truncate text-[11px]">{row.parallel.note}</span>
          ) : null}
        </span>
      </span>
    )
  }

  const started =
    activity.startedAtMs === null
      ? null
      : translate('fork.heimdall.activity.started', 'Started {{age}}', {
          age: formatHeimdallAge(activity.startedAtMs, asOfMs)
        })
  const detail = [row.parallel?.note, activity.detail?.replace(/[-_]+/g, ' '), started]
    .filter((value): value is string => Boolean(value))
    .join(' · ')
  const label = row.parallel
    ? translate(
        'fork.heimdall.activity.objectiveConcurrencyRunning',
        '{{count}} of {{cap}} running',
        {
          count: objectiveRunningCount,
          cap: row.parallel.effectiveMaxConcurrency
        }
      )
    : activity.kind === 'agent-in-flight'
      ? objectiveConcurrency === null
        ? activity.count === 1
          ? translate('fork.heimdall.activity.agentInFlight', 'Agent work in flight')
          : translate('fork.heimdall.activity.agentsInFlight', '{{count}} agent tasks in flight', {
              count: activity.count
            })
        : translate(
            'fork.heimdall.activity.objectiveConcurrencyRunning',
            '{{count}} of {{cap}} running',
            { count: activity.count, cap: objectiveConcurrency }
          )
      : activity.kind === 'check-running'
        ? translate('fork.heimdall.activity.checkRunning', 'Check running')
        : translate('fork.heimdall.activity.actionRunning', 'Action running')
  const Icon =
    activity.kind === 'agent-in-flight'
      ? Bot
      : activity.kind === 'check-running'
        ? ListChecks
        : Play
  return (
    <span className="flex min-w-0 items-start gap-1.5" title={detail || label}>
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium">{label}</span>
        {detail ? (
          <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
        ) : null}
      </span>
    </span>
  )
}

function WorkspaceCell({
  row,
  current
}: {
  row: WatcherFleetEntry
  current: boolean
}): React.JSX.Element {
  const workspace = resolveFleetWorkspace(row)
  const branch = workspace.branch?.replace(/^refs\/heads\//, '') ?? null
  const location =
    workspace.kind === 'folder'
      ? translate('fork.heimdall.workspace.folder', 'Folder')
      : (branch ?? translate('fork.heimdall.workspace.branchUnavailable', 'Branch unavailable'))
  const detail = workspace.hostLabel ? `${location} · ${workspace.hostLabel}` : location
  return (
    <span className="flex min-w-0 items-start gap-2">
      {current ? (
        <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0" title={`${workspace.fullPath}\n${detail}`}>
        <span className="block truncate font-medium">{workspace.label}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
      </span>
    </span>
  )
}

export type HeimdallFleetListProps = {
  rows: readonly WatcherFleetEntry[]
  asOfMs: number
  selected: WatcherTarget | null
  onSelect: (target: WatcherTarget) => void
}

export function HeimdallFleetList({
  rows,
  asOfMs,
  selected,
  onSelect
}: HeimdallFleetListProps): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-border bg-muted/20 px-4 py-12 text-center">
        <div className="text-sm font-medium text-foreground">
          {translate('fork.heimdall.fleet.emptyTitle', 'No watchers in the fleet')}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {translate(
            'fork.heimdall.fleet.emptyDescription',
            'Arm a watcher from a supported workspace to see it here.'
          )}
        </p>
      </div>
    )
  }
  return (
    <div className={cn(LIST_TABLE_CONTAINER_CLASS, 'scrollbar-sleek overflow-x-auto')}>
      <div className={cn(GRID, LIST_TABLE_HEADER_CLASS)}>
        <span>{translate('fork.heimdall.fleet.workspace', 'Workspace')}</span>
        <span>{translate('fork.heimdall.fleet.name', 'Watcher')}</span>
        <span>{translate('fork.heimdall.fleet.activity', 'Activity')}</span>
        <span>{translate('fork.heimdall.fleet.phase', 'Phase')}</span>
        <span>{translate('fork.heimdall.fleet.status', 'Status')}</span>
        <span>{translate('fork.heimdall.fleet.activeBurn', 'Active time')}</span>
        <span className="text-right">{translate('fork.heimdall.fleet.turns', 'Turns')}</span>
        <span className="text-right">{translate('fork.heimdall.fleet.elapsed', 'Elapsed')}</span>
        <span className="text-right">{translate('fork.heimdall.fleet.lastTick', 'Last tick')}</span>
      </div>
      <div>
        {rows.map((row) => {
          const current = sameWatcherTarget(selected, row.target)
          const turnsLimit = row.entry.enrollment.budget.turns
          const phase = workflowPhaseLabel(resolveFleetWorkflowPhase(row))
          return (
            <button
              key={`${row.target.connectionId ?? 'local'}:${row.target.pairingRevision ?? 'local'}:${row.target.watcherId}`}
              type="button"
              data-current={current ? 'true' : undefined}
              className={cn(GRID, LIST_TABLE_ROW_CLASS, current && LIST_TABLE_ROW_SELECTED_CLASS)}
              onClick={() => onSelect(row.target)}
              aria-pressed={current}
            >
              <WorkspaceCell row={row} current={current} />
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium" title={row.entry.name}>
                  {row.entry.name}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {row.entry.enrollment.kind === 'objective'
                    ? translate('fork.heimdall.kind.objective', 'Objective')
                    : translate('fork.heimdall.kind.hostedReview', 'Hosted review')}
                </span>
              </span>
              <ActivityIndicator row={row} asOfMs={asOfMs} />
              <span className="truncate text-xs" title={phase}>
                {phase}
              </span>
              <span className="min-w-0 overflow-hidden">
                <HeimdallStatusPill row={row} />
              </span>
              <ActiveBurn row={row} />
              <span className="text-right text-xs tabular-nums">
                {row.entry.status.budget.turns}/{turnsLimit ?? '∞'}
              </span>
              <span className="text-right text-xs tabular-nums">
                {formatHeimdallDuration(asOfMs - row.entry.enrollment.createdAtMs)}
              </span>
              <span className="text-right text-xs text-muted-foreground tabular-nums">
                {formatHeimdallAge(row.entry.status.lastSuccessfulTickAtMs, asOfMs)}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
