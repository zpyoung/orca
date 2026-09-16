import { lazy, Suspense } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-types'
import { objectiveHandoffOrigin } from '../fork-heimdall-objective/handoff-evidence'
import { sameWatcherTarget } from './fleet-selectors'

const ObjectiveDetailSection = lazy(() =>
  import('../fork-heimdall-objective/ObjectiveDetailSection').then((module) => ({
    default: module.ObjectiveDetailSection
  }))
)
const EMPTY_FLEET: readonly WatcherFleetEntry[] = []

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
          className="h-auto justify-start p-0 text-xs"
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
  ledger
}: {
  row: WatcherFleetEntry
  ledger: WatcherLedger | null
}): React.JSX.Element | null {
  switch (row.entry.enrollment.kind) {
    case 'objective':
      return (
        <Suspense
          fallback={
            <p className="text-xs text-muted-foreground">
              {translate('fork.heimdallObjective.detail.loading', 'Loading objective state…')}
            </p>
          }
        >
          <ObjectiveDetailSection row={row} ledger={ledger} />
        </Suspense>
      )
    case 'hosted-review':
      return <HostedReviewHandoffOrigin row={row} ledger={ledger} />
  }
}
