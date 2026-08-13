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

// Why: two thresholds instead of one give the flip a dead zone — a pane
// hovering at a single boundary would mount/unmount every resize tick.
export const AUTO_UNDOCK_LOW_THRESHOLD_PX = 180
export const AUTO_UNDOCK_HIGH_THRESHOLD_PX = 220

export function terminalDockGutterHeightPx(gutterRows: number): number {
  return CHROME_HEIGHT_PX + gutterRows * ROW_HEIGHT_PX
}

function useAutoUndock(paneHeightPx: number): boolean {
  const [mounted, setMounted] = useState(() => paneHeightPx >= AUTO_UNDOCK_LOW_THRESHOLD_PX)

  useEffect(() => {
    setMounted((wasMounted) => {
      if (wasMounted && paneHeightPx < AUTO_UNDOCK_LOW_THRESHOLD_PX) {
        return false
      }
      if (!wasMounted && paneHeightPx >= AUTO_UNDOCK_HIGH_THRESHOLD_PX) {
        return true
      }
      return wasMounted
    })
  }, [paneHeightPx])

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
 *  keystroke. Unmounts below a minimum pane height and re-mounts above a
 *  strictly greater one so a 1px resize jitter can't flap it. */
export function TerminalDock(props: TerminalDockProps): React.JSX.Element | null {
  const { terminalTabId, paneKey, targetPtyId, agent, paneHeightPx, disabledReason } = props
  const gutterRows = props.gutterRows ?? DEFAULT_GUTTER_ROWS
  const mounted = useAutoUndock(paneHeightPx)

  if (!mounted) {
    return null
  }

  return (
    <div
      className="flex flex-col border-t border-border bg-background"
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
