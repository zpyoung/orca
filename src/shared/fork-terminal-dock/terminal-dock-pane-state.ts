/** Per-pane docked-composer state; gutterRows is an integer clamped to 3..15. */
export type TerminalDockPaneState = {
  docked: boolean
  gutterRows: number
}
