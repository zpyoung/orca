import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { selectPendingAskTabIds } from './pending-ask-attention'

/**
 * Tab ids currently holding a non-terminal ask.
 *
 * Subscribes through a shallow-compared sorted array so unrelated store ticks neither rebuild the
 * set nor re-render the caller — the palette resolves this once per open and reads it per row.
 */
export function usePendingAskTabIds(): ReadonlySet<string> {
  const tabIds = useAppStore(useShallow(selectPendingAskTabIds))
  return useMemo(() => new Set(tabIds), [tabIds])
}
