import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  LedgerEntry,
  LedgerFilters,
  LedgerRequest,
  LedgerSummary,
  LedgerTarget
} from '../../../../shared/ledger'
import { requestLedger } from '@/runtime/runtime-ledger-client'

type LedgerRequestOptions = {
  target: LedgerTarget | null
  environmentId?: string
  isVisible: boolean
  filters?: LedgerFilters
}
type LedgerRequestError = { code?: string; message: string }
type LedgerListState = {
  ledger: LedgerSummary | null
  entries: LedgerEntry[]
  loading: boolean
  error: LedgerRequestError | null
}
const EMPTY_STATE: LedgerListState = { ledger: null, entries: [], loading: false, error: null }

export function useLedgerRequest({
  target,
  environmentId,
  isVisible,
  filters
}: LedgerRequestOptions): LedgerListState & {
  perform: (request: LedgerRequest) => Promise<void>
  refresh: () => Promise<void>
} {
  const selectionKey = JSON.stringify([environmentId ?? null, target])
  const filterKey = JSON.stringify(filters ?? {})
  const selection = useMemo(() => {
    const [host, scope] = JSON.parse(selectionKey) as [string | null, LedgerTarget | null]
    return { environmentId: host ?? undefined, target: scope }
  }, [selectionKey])
  const query = useMemo(
    () => ({ selection, filters: JSON.parse(filterKey) as LedgerFilters }),
    [selection, filterKey]
  )
  const [state, setState] = useState<{ query: typeof query; value: LedgerListState } | null>(null)
  const current = useRef({ query, isVisible, mounted: false })
  const generation = useRef(0)
  const lastRequested = useRef<typeof query | null>(null)

  useLayoutEffect(() => {
    current.current = { query, isVisible, mounted: true }
  }, [query, isVisible])
  useLayoutEffect(() => {
    return () => {
      current.current.mounted = false
      generation.current += 1
      lastRequested.current = null
    }
  }, [])

  const load = useCallback(async (requested: typeof query): Promise<void> => {
    const active = current.current
    if (!active.mounted || !active.isVisible || active.query !== requested) {
      return
    }
    const { target: scope, environmentId: host } = requested.selection
    if (!scope) {
      return
    }
    const expectedGeneration = ++generation.current
    lastRequested.current = requested
    const isCurrent = () =>
      current.current.mounted &&
      current.current.query === requested &&
      generation.current === expectedGeneration
    setState((previous) => ({
      query: requested,
      value: {
        ...(previous?.query === requested ? previous.value : EMPTY_STATE),
        loading: true,
        error: null
      }
    }))
    try {
      const response = await requestLedger(
        { operation: 'list', target: scope, filters: requested.filters },
        host
      )
      if (!isCurrent()) {
        return
      }
      setState({
        query: requested,
        value: {
          ledger: response.ledger,
          entries: response.entries ?? [],
          loading: false,
          error: null
        }
      })
    } catch (cause) {
      if (!isCurrent()) {
        return
      }
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
      const error = {
        ...(typeof code === 'string' ? { code } : {}),
        message: cause instanceof Error ? cause.message : String(cause)
      }
      setState((previous) => ({
        query: requested,
        value: {
          ...(previous?.query === requested ? previous.value : EMPTY_STATE),
          loading: false,
          error
        }
      }))
    }
  }, [])

  const refresh = useCallback(() => load(query), [load, query])
  useEffect(() => {
    if (isVisible && lastRequested.current !== query) {
      void refresh()
    }
  }, [isVisible, query, refresh])

  const perform = useCallback(
    async (request: LedgerRequest): Promise<void> => {
      if (!selection.target) {
        throw new Error('Ledger target unavailable')
      }
      await requestLedger({ ...request, target: selection.target }, selection.environmentId)
      const active = current.current
      // Selection identity fences a mutation even after an A → B → A round trip.
      if (!active.mounted || active.query.selection !== selection) {
        return
      }
      generation.current += 1
      lastRequested.current = null
      await load(active.query)
    },
    [load, selection]
  )

  const displayed = state?.query === query ? state.value : EMPTY_STATE
  return {
    ...displayed,
    loading: state?.query === query ? displayed.loading : Boolean(target && isVisible),
    perform,
    refresh
  }
}
