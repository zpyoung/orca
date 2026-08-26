import { app, ipcMain } from 'electron'
import { ForkSessionHandoffLineageStore } from './session-lineage-store'
import {
  parseForkSessionHandoffLineageEnrichment,
  parseForkSessionHandoffLineageRecord
} from './session-lineage-validation'

export const FORK_SESSION_HANDOFF_LINEAGE_CHANNELS = {
  list: 'forkSessionHandoff:lineageList',
  record: 'forkSessionHandoff:lineageRecord',
  enrich: 'forkSessionHandoff:lineageEnrich'
} as const

type LineageStore = Pick<ForkSessionHandoffLineageStore, 'list' | 'record' | 'enrich'>

/** Register validated IPC handlers for lineage list, record, and enrichment operations. */
export function registerForkSessionHandoffHandlers(
  store: LineageStore = new ForkSessionHandoffLineageStore(app.getPath('userData'))
): void {
  ipcMain.handle(FORK_SESSION_HANDOFF_LINEAGE_CHANNELS.list, () => store.list())
  ipcMain.handle(FORK_SESSION_HANDOFF_LINEAGE_CHANNELS.record, async (_event, value: unknown) => {
    const record = parseForkSessionHandoffLineageRecord(value)
    if (!record) {
      throw new Error('Invalid session handoff lineage record.')
    }
    await store.record(record)
  })
  ipcMain.handle(FORK_SESSION_HANDOFF_LINEAGE_CHANNELS.enrich, async (_event, value: unknown) => {
    const enrichment = parseForkSessionHandoffLineageEnrichment(value)
    if (!enrichment) {
      throw new Error('Invalid session handoff lineage enrichment.')
    }
    await store.enrich(enrichment)
  })
}
