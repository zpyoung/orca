import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { ObjectiveDetail } from '../../../shared/fork-heimdall-objective/detail-types'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherFleetEntry, WatcherTarget } from '../../../shared/fork-heimdall/fleet-types'
import { ObjectiveDetailContent } from './ObjectiveDetailContent'
import {
  describeObjectiveError,
  getObjectiveHeimdallApi,
  isObjectiveDetailUnavailableError
} from './objective-heimdall-api'

function sameTarget(left: WatcherTarget, right: WatcherTarget): boolean {
  return (
    left.watcherId === right.watcherId &&
    left.connectionId === right.connectionId &&
    left.pairingRevision === right.pairingRevision
  )
}

function targetSignature(target: WatcherTarget): string {
  return [target.connectionId ?? 'local', target.pairingRevision ?? 'local', target.watcherId].join(
    ':'
  )
}

function detailRefreshSignature(row: WatcherFleetEntry): string {
  return [
    row.target.connectionId ?? 'local',
    row.target.pairingRevision ?? 'local',
    row.target.watcherId,
    row.ownerFence.executionHostId,
    row.ownerFence.schedulerOwner,
    row.ownerFence.workspaceKey,
    row.ownerFence.revision,
    row.observedAtMs,
    row.contact
  ].join(':')
}

export function ObjectiveDetailSection({
  row,
  ledger
}: {
  row: WatcherFleetEntry
  ledger: WatcherLedger | null
}): React.JSX.Element {
  const api = getObjectiveHeimdallApi()
  const [detail, setDetail] = useState<ObjectiveDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [unavailable, setUnavailable] = useState(!api || typeof api.objectiveDetail !== 'function')
  const [error, setError] = useState<string | null>(null)
  const generationRef = useRef(0)
  const detailTargetRef = useRef<string | null>(null)
  const errorTargetRef = useRef<string | null>(null)
  const unavailableTargetRef = useRef<string | null>(null)
  const currentTargetSignature = targetSignature(row.target)
  const signature = detailRefreshSignature(row)
  const signatureRef = useRef(signature)
  signatureRef.current = signature

  const refresh = useCallback(async (): Promise<void> => {
    if (!api || typeof api.objectiveDetail !== 'function') {
      setUnavailable(true)
      setLoading(false)
      return
    }
    const requestGeneration = ++generationRef.current
    const requestSignature = signature
    const requestTargetSignature = currentTargetSignature
    setLoading(true)
    try {
      const nextDetail = await api.objectiveDetail(row.target)
      if (
        generationRef.current !== requestGeneration ||
        signatureRef.current !== requestSignature
      ) {
        return
      }
      detailTargetRef.current = requestTargetSignature
      errorTargetRef.current = null
      unavailableTargetRef.current = null
      setDetail(nextDetail)
      setUnavailable(false)
      setError(null)
    } catch (cause) {
      if (
        generationRef.current !== requestGeneration ||
        signatureRef.current !== requestSignature
      ) {
        return
      }
      if (isObjectiveDetailUnavailableError(cause)) {
        setDetail(null)
        detailTargetRef.current = null
        errorTargetRef.current = null
        unavailableTargetRef.current = requestTargetSignature
        setUnavailable(true)
        setError(null)
      } else {
        setError(describeObjectiveError(cause))
        errorTargetRef.current = requestTargetSignature
      }
    } finally {
      if (
        generationRef.current === requestGeneration &&
        signatureRef.current === requestSignature
      ) {
        setLoading(false)
      }
    }
  }, [api, currentTargetSignature, row.target, signature])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!api) {
      return
    }
    return api.onFleetChanged((snapshot) => {
      if (snapshot.entries.some((entry) => sameTarget(entry.target, row.target))) {
        void refresh()
      }
    })
  }, [api, refresh, row.target])

  const visibleDetail = detailTargetRef.current === currentTargetSignature ? detail : null
  const visibleError = errorTargetRef.current === currentTargetSignature ? error : null
  const visibleUnavailable =
    !api ||
    typeof api.objectiveDetail !== 'function' ||
    (unavailable && unavailableTargetRef.current === currentTargetSignature)

  if (visibleUnavailable) {
    return (
      <section aria-labelledby="objective-detail-title">
        <h3
          id="objective-detail-title"
          className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground"
        >
          {translate('fork.heimdallObjective.detail.title', 'Objective')}
        </h3>
        <p className="rounded-md border border-border bg-muted/10 px-3 py-3 text-xs text-muted-foreground">
          {translate(
            'fork.heimdallObjective.detail.unavailable',
            'Objective detail is not available from this host.'
          )}
        </p>
      </section>
    )
  }

  return (
    <div className="space-y-3" data-objective-detail="">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">
          {visibleDetail
            ? translate('fork.heimdallObjective.detail.asOf', 'Objective state as of {{time}}', {
                time: new Intl.DateTimeFormat(undefined, {
                  hour: 'numeric',
                  minute: '2-digit',
                  second: '2-digit'
                }).format(visibleDetail.asOfMs)
              })
            : translate('fork.heimdallObjective.detail.loading', 'Loading objective state…')}
        </p>
        {loading ? (
          <Loader2
            className="size-3.5 animate-spin text-muted-foreground"
            aria-label={translate(
              'fork.heimdallObjective.detail.refreshing',
              'Refreshing objective detail'
            )}
          />
        ) : null}
      </div>
      {visibleError ? (
        <p className="text-xs text-destructive" role="alert">
          {visibleDetail
            ? translate(
                'fork.heimdallObjective.detail.staleError',
                'Objective refresh failed; showing the last confirmed state: {{error}}',
                { error: visibleError }
              )
            : translate(
                'fork.heimdallObjective.detail.loadError',
                'Objective detail could not be loaded: {{error}}',
                { error: visibleError }
              )}
        </p>
      ) : null}
      {visibleDetail ? (
        <ObjectiveDetailContent detail={visibleDetail} ledger={ledger} row={row} />
      ) : !visibleError ? (
        <div
          className="h-20 animate-pulse rounded-md border border-border bg-muted/20"
          aria-hidden
        />
      ) : null}
    </div>
  )
}
