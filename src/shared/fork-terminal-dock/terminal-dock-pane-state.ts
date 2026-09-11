/** Per-pane docked-composer state; gutterRows is an integer clamped to 3..15. */
export type TerminalDockPaneState = {
  docked: boolean
  gutterRows: number
  /** Set when the user closed this pane's dock themselves, which suppresses automatic
   *  docking on every client — an agent-exit undock leaves it alone so a relaunch re-docks.
   *  Absent on records written before the field existed, which read as no decision. */
  userUndocked?: boolean
}
