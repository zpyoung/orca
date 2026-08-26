// Per-pane docked-composer state as persisted on a unified tab in the
// workspace session file.

import { z } from 'zod'
import { MAX_GUTTER_ROWS, MIN_GUTTER_ROWS } from './terminal-dock-gutter-rows'

// Why: mirrors the unsafe-key guard in workspace-session-sleeping-agents.ts;
// duplicated locally since that module doesn't export it.
const isUnsafeTabRecordKey = (value: string): boolean =>
  value === '__proto__' || value === 'constructor' || value === 'prototype'

const terminalDockPaneStateSchema = z.object({
  docked: z.boolean(),
  gutterRows: z.number().int().min(MIN_GUTTER_ROWS).max(MAX_GUTTER_ROWS),
  userUndocked: z.boolean().optional()
})

// Why: each pane's dock state must validate independently — a single
// corrupted entry must never fail the whole tab (and thus session) parse.
export const terminalDockByPaneKeySchema = z.preprocess((raw) => {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined
  }
  const entries = Object.entries(raw as Record<string, unknown>).flatMap(([paneKey, value]) => {
    if (isUnsafeTabRecordKey(paneKey)) {
      return []
    }
    const parsed = terminalDockPaneStateSchema.safeParse(value)
    return parsed.success ? [[paneKey, parsed.data] as const] : []
  })
  // an empty record is the host-has-echoed sentinel; only a record that lost
  // every entry to corruption hydrates as absent
  return entries.length === 0 && Object.keys(raw as Record<string, unknown>).length > 0
    ? undefined
    : Object.fromEntries(entries)
}, z.record(z.string(), terminalDockPaneStateSchema).optional())
