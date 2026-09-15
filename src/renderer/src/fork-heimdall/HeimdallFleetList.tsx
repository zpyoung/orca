import { Check } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  LIST_TABLE_CONTAINER_CLASS,
  LIST_TABLE_HEADER_CLASS,
  LIST_TABLE_ROW_CLASS,
  LIST_TABLE_ROW_SELECTED_CLASS
} from '@/lib/list-table-layout'
import type { WatcherFleetEntry, WatcherTarget } from '../../../shared/fork-heimdall/fleet-types'
import { formatHeimdallAge, formatHeimdallDuration } from './fleet-format'
import { sameWatcherTarget } from './fleet-selectors'
import { HeimdallStatusPill } from './HeimdallStatusPill'

const GRID =
  'grid min-w-[720px] grid-cols-[minmax(135px,1.4fr)_minmax(120px,1fr)_minmax(85px,0.8fr)_110px_52px_58px_82px]'

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
        <span>{translate('fork.heimdall.fleet.name', 'Watcher')}</span>
        <span>{translate('fork.heimdall.fleet.status', 'Status')}</span>
        <span>{translate('fork.heimdall.fleet.phase', 'Phase')}</span>
        <span>{translate('fork.heimdall.fleet.activeBurn', 'Active time')}</span>
        <span className="text-right">{translate('fork.heimdall.fleet.turns', 'Turns')}</span>
        <span className="text-right">{translate('fork.heimdall.fleet.elapsed', 'Elapsed')}</span>
        <span className="text-right">{translate('fork.heimdall.fleet.lastTick', 'Last tick')}</span>
      </div>
      <div>
        {rows.map((row) => {
          const current = sameWatcherTarget(selected, row.target)
          const turnsLimit = row.entry.enrollment.budget.turns
          return (
            <button
              key={`${row.target.connectionId ?? 'local'}:${row.target.pairingRevision ?? 'local'}:${row.target.watcherId}`}
              type="button"
              data-current={current ? 'true' : undefined}
              className={cn(GRID, LIST_TABLE_ROW_CLASS, current && LIST_TABLE_ROW_SELECTED_CLASS)}
              onClick={() => onSelect(row.target)}
              aria-pressed={current}
            >
              <span className="flex min-w-0 items-center gap-2 font-medium">
                {current ? (
                  <Check className="size-3.5 shrink-0" aria-hidden />
                ) : (
                  <span className="size-3.5" />
                )}
                <span className="truncate" title={row.entry.name}>
                  {row.entry.name}
                </span>
              </span>
              <span className="min-w-0 overflow-hidden">
                <HeimdallStatusPill row={row} />
              </span>
              <span
                className="truncate text-xs text-muted-foreground"
                title={row.entry.status.phase}
              >
                {row.entry.status.phase}
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
