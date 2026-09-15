import { lazy, Suspense } from 'react'
import { translate } from '@/i18n/i18n'
import type { WatcherFleetEntry } from '../../../shared/fork-heimdall/fleet-types'

const ObjectiveDetailSection = lazy(() =>
  import('../fork-heimdall-objective/ObjectiveDetailSection').then((module) => ({
    default: module.ObjectiveDetailSection
  }))
)

export function HeimdallKindDetail({ row }: { row: WatcherFleetEntry }): React.JSX.Element | null {
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
          <ObjectiveDetailSection row={row} />
        </Suspense>
      )
    case 'hosted-review':
      return null
  }
}
