import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { ApprovalScope, WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherFleetEntryReader } from '../../../shared/fork-heimdall/remote-reader-schemas'
import type {
  WatcherCommandResult,
  WatcherFleetEntry
} from '../../../shared/fork-heimdall/fleet-types'
import type { PipelineChoiceCommand } from '../fork-heimdall-pipeline/PipelineGateDialog'
import { PipelineRunGraph } from '../fork-heimdall-pipeline/PipelineRunGraph'
import {
  fallbackPipelineRunView,
  loadPipelineRunView
} from '../fork-heimdall-pipeline/pipeline-run-view-client'
import { objectiveHandoffOrigin } from '../fork-heimdall-objective/handoff-evidence'
import { sameWatcherTarget } from './fleet-selectors'

const ObjectiveDetailSection = lazy(() =>
  import('../fork-heimdall-objective/ObjectiveDetailSection').then((module) => ({
    default: module.ObjectiveDetailSection
  }))
)

const EMPTY_FLEET: readonly WatcherFleetEntryReader[] = []

function targetKey(row: WatcherFleetEntryReader): string {
  return `${row.target.connectionId ?? 'local'}:${row.target.pairingRevision ?? 'local'}:${row.target.watcherId}`
}

function runViewKey(row: WatcherFleetEntryReader): string {
  return [targetKey(row), row.ownerFence.revision, row.observedAtMs, row.contact].join(':')
}

function isKnownWatcherEntry(row: WatcherFleetEntryReader): row is WatcherFleetEntry {
  return row.entry.enrollment.kind !== 'unknown'
}

function HostedReviewHandoffOrigin({
  row,
  ledger
}: {
  row: WatcherFleetEntry
  ledger: WatcherLedger | null
}): React.JSX.Element | null {
  const fleet = useAppStore((state) => state.heimdallFleet?.entries ?? EMPTY_FLEET)
  const selectWatcher = useAppStore((state) => state.selectHeimdallWatcher)
  const origin = objectiveHandoffOrigin(ledger)
  if (!origin) {
    return null
  }
  const objectiveTarget = { ...row.target, watcherId: origin.objectiveWatcherId }
  const objective = fleet.find((candidate) => sameWatcherTarget(objectiveTarget, candidate.target))
  const label = translate(
    'fork.heimdall.kindDetail.handedOffFrom',
    'Handed off from objective {{id}}',
    { id: origin.objectiveWatcherId }
  )
  return (
    <section aria-label={label}>
      {objective ? (
        <Button
          type="button"
          variant="link"
          size="xs"
          className="h-auto justify-start"
          onClick={() => selectWatcher(objective.target)}
        >
          {label}
        </Button>
      ) : (
        <p className="text-xs text-muted-foreground">{label}</p>
      )}
    </section>
  )
}

export function HeimdallKindDetail({
  row,
  ledger,
  readOnly,
  busy,
  onAnswer,
  onApprove,
  onAnswered
}: {
  row: WatcherFleetEntryReader
  ledger: WatcherLedger | null
  readOnly: boolean
  busy: boolean
  onAnswer: (command: PipelineChoiceCommand) => Promise<WatcherCommandResult | null>
  onApprove?: (scope: ApprovalScope) => Promise<WatcherCommandResult | null>
  onAnswered?: () => void
}): React.JSX.Element {
  const [loadedView, setLoadedView] = useState(() => ({
    key: runViewKey(row),
    view: fallbackPipelineRunView(row)
  }))
  const generation = useRef(0)
  const key = runViewKey(row)
  const view = loadedView.key === key ? loadedView.view : fallbackPipelineRunView(row)

  const refreshRunView = useCallback(async (): Promise<void> => {
    const requestGeneration = ++generation.current
    const nextView = await loadPipelineRunView(row)
    if (generation.current === requestGeneration) {
      setLoadedView({ key, view: nextView })
    }
  }, [key, row])

  useEffect(() => {
    void refreshRunView()
    return () => {
      generation.current += 1
    }
  }, [refreshRunView])

  const kind = row.entry.enrollment.kind
  const knownRow = isKnownWatcherEntry(row) ? row : null
  const controlsReadOnly =
    readOnly ||
    kind === 'unknown' ||
    row.contact === 'unverifiable' ||
    row.entry.status.state === 'unreachable'

  return (
    <section className="space-y-4" data-testid="heimdall-kind-detail">
      <PipelineRunGraph
        view={view}
        surface="heimdall-detail"
        row={row}
        ledger={ledger}
        readOnly={controlsReadOnly}
        busy={busy}
        onAnswer={onAnswer}
        onApprove={onApprove}
        onAnswered={async () => {
          await refreshRunView()
          onAnswered?.()
        }}
      />
      {kind === 'objective' && knownRow ? (
        <Suspense
          fallback={
            <p className="text-xs text-muted-foreground">
              {translate('fork.heimdallObjective.detail.loading', 'Loading objective state…')}
            </p>
          }
        >
          <ObjectiveDetailSection row={knownRow} ledger={ledger} />
        </Suspense>
      ) : null}
      {kind === 'hosted-review' && knownRow ? (
        <HostedReviewHandoffOrigin row={knownRow} ledger={ledger} />
      ) : null}
    </section>
  )
}
