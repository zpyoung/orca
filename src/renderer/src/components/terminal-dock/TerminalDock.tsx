import { useEffect, useState } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { cn } from '@/lib/utils'
import { AgentComposer } from '../agent-composer/AgentComposer'
import { DEFAULT_GUTTER_ROWS } from './terminal-dock-pane-state'

// Row height mirrors the composer field's text-sm/leading-5 (20px) so a
// gutterRows count tracks visible textarea lines; the remainder covers the
// composer's own card padding and action row, which don't scale with rows.
const ROW_HEIGHT_PX = 20
const CHROME_HEIGHT_PX = 96

// A gutter that fits exactly is still useless — the terminal above it is the
// ground truth the user watches their text land in, so undocking must leave
// it a minimum of visible rows rather than trigger on gutter fit alone.
const MIN_VISIBLE_TERMINAL_PX = 60

// Why: two thresholds instead of one give the flip a dead zone — a pane
// hovering at a single boundary would mount/unmount every resize tick.
const HYSTERESIS_BAND_PX = 40

export function terminalDockGutterHeightPx(gutterRows: number): number {
  return CHROME_HEIGHT_PX + gutterRows * ROW_HEIGHT_PX
}

// Thresholds scale with gutterRows: a taller gutter needs a taller pane
// before it can dock without starving the terminal above it.
export function terminalDockAutoUndockLowThresholdPx(gutterRows: number): number {
  return terminalDockGutterHeightPx(gutterRows) + MIN_VISIBLE_TERMINAL_PX
}

export function terminalDockAutoUndockHighThresholdPx(gutterRows: number): number {
  return terminalDockAutoUndockLowThresholdPx(gutterRows) + HYSTERESIS_BAND_PX
}

function useAutoUndock(paneHeightPx: number, gutterRows: number): boolean {
  const [mounted, setMounted] = useState(
    () => paneHeightPx >= terminalDockAutoUndockHighThresholdPx(gutterRows)
  )

  useEffect(() => {
    const lowThreshold = terminalDockAutoUndockLowThresholdPx(gutterRows)
    const highThreshold = terminalDockAutoUndockHighThresholdPx(gutterRows)
    setMounted((wasMounted) => {
      if (wasMounted && paneHeightPx < lowThreshold) {
        return false
      }
      if (!wasMounted && paneHeightPx >= highThreshold) {
        return true
      }
      return wasMounted
    })
  }, [paneHeightPx, gutterRows])

  return mounted
}

export type TerminalDockProps = {
  terminalTabId: string
  paneKey: string
  targetPtyId: string | null
  agent: AgentType
  /** Current height of the hosting pane in pixels; drives auto-undock. */
  paneHeightPx: number
  /** Gutter rows this pane persisted, or the default when it hasn't. */
  gutterRows?: number
  /** Short reason the composer can't accept input right now, or null when it can. */
  disabledReason: string | null
}

/** Fixed-height gutter beneath a terminal pane hosting the mountable
 *  composer core. Height depends only on gutterRows, never on draft
 *  content — the pane's resize path fires a PTY SIGWINCH on geometry
 *  change, so a content-driven height would resize the PTY on every
 *  keystroke. Unmounts below a pane height derived from the current
 *  gutterRows and re-mounts above a strictly greater derived threshold
 *  so a 1px resize jitter can't flap it. */
export function TerminalDock(props: TerminalDockProps): React.JSX.Element | null {
  const { terminalTabId, paneKey, targetPtyId, agent, paneHeightPx, disabledReason } = props
  const gutterRows = props.gutterRows ?? DEFAULT_GUTTER_ROWS
  const mounted = useAutoUndock(paneHeightPx, gutterRows)

  if (!mounted) {
    return null
  }

  return (
    <div
      className="flex shrink-0 flex-col border-t border-border bg-background"
      style={{ height: terminalDockGutterHeightPx(gutterRows) }}
      data-pane-prevent-terminal-focus
      data-terminal-dock=""
    >
      <div
        className="flex h-4 shrink-0 items-center px-3 pt-1 text-[11px] font-medium text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <span className={cn(disabledReason === null && 'invisible')}>{disabledReason}</span>
      </div>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
        <AgentComposer
          terminalTabId={terminalTabId}
          paneKey={paneKey}
          targetPtyId={targetPtyId}
          agent={agent}
          canSend={disabledReason === null}
        />
      </div>
    </div>
  )
}
