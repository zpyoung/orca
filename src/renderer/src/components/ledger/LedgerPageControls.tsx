import type {
  LedgerEntry,
  LedgerEntryType,
  LedgerFilters,
  LedgerOwner,
  LedgerRequest,
  LedgerState,
  LedgerSummary,
  LedgerTarget
} from '../../../../shared/ledger'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  controlsAllStates,
  controlsAllTypes,
  controlsAttach,
  controlsAttachConfirm,
  controlsAttachmentOwner,
  controlsAttachPlaceholder,
  controlsBranchFilter,
  controlsBranchPlaceholder,
  controlsBulkState,
  controlsBulkStateConfirm,
  controlsDeleteLedger,
  controlsDeleteLedgerConfirm,
  controlsDeleteSelected,
  controlsDeleteSelectedConfirm,
  controlsNewEntry,
  controlsNoLedger,
  controlsNotStale,
  controlsOpenLedger,
  controlsRefresh,
  controlsReviewed,
  controlsReviewedAll,
  controlsReviewFilter,
  controlsReviewSelected,
  controlsRuntimeTitle,
  controlsSearchEntries,
  controlsSearchPlaceholder,
  controlsSettings,
  controlsSimilarEntries,
  controlsSortLabel,
  controlsSortSequence,
  controlsSortTitle,
  controlsSortUpdated,
  controlsStale,
  controlsStaleAll,
  controlsStaleFilter,
  controlsStateFilter,
  controlsSummaryLine,
  controlsTriage,
  controlsTypeFilter,
  controlsUnreviewed,
  controlsWorkspaceFilter,
  controlsWorkspacePlaceholder
} from './ledger-page-controls-copy'

const types: LedgerEntryType[] = ['bug', 'deferred', 'test-gap', 'proposal', 'decision']
const states: LedgerState[] = ['open', 'resolved', 'archived']

export type LedgerPageControlsProps = {
  title: string
  ledger: LedgerSummary | null
  ownerLabel: string | null
  target?: LedgerTarget
  busy: boolean
  ledgerError: string | null
  error: string | null
  matches: LedgerEntry[]
  attachTo: string
  attachCandidates: (LedgerOwner & { label: string })[]
  catalogError: string | null
  type: LedgerEntryType | 'all'
  state: LedgerState | 'all'
  reviewed: string
  stale: string
  workspace: string
  branch: string
  sort: string
  query: string
  selected: Map<string, number>
  filters: LedgerFilters
  onOpen: () => void
  onOpenSettings: (() => void) | null
  onRefresh: () => void
  onTriage: () => void
  onNew: () => void
  onConfirm: (message: string, request: LedgerRequest) => void
  onAttachTo: (value: string) => void
  onFilterChange: (key: string, value: string) => void
  onDetail: (id: string) => void
  onMutate: (request: LedgerRequest) => void
}

export function LedgerPageControls({
  title,
  ledger,
  ownerLabel,
  target,
  busy,
  ledgerError,
  error,
  matches,
  attachTo,
  attachCandidates,
  catalogError,
  type,
  state,
  reviewed,
  stale,
  workspace,
  branch,
  sort,
  query,
  selected,
  onOpen,
  onOpenSettings,
  onRefresh,
  onTriage,
  onNew,
  onConfirm,
  onAttachTo,
  onFilterChange,
  onDetail,
  onMutate
}: LedgerPageControlsProps): React.JSX.Element {
  const mutationTarget = ledger ? { ledgerId: ledger.ledgerId } : target
  return (
    <>
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b px-6 py-4">
        <div className="min-w-0">
          <Button variant="link" size="sm" onClick={onOpen}>
            {controlsOpenLedger()}
          </Button>
          <h1 className="text-lg font-semibold">
            {ownerLabel ?? ledger?.owner?.id ?? ledger?.formerOwner?.id ?? title}
          </h1>
          {ledger ? (
            <>
              <p className="break-words text-sm text-muted-foreground">
                {controlsSummaryLine(ledger)}
              </p>
              <p
                className="break-words font-mono text-xs text-muted-foreground/70"
                title={controlsRuntimeTitle(ledger.runtime.runtimeId, ledger.runtime.profileId)}
              >
                {ledger.ledgerId}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{controlsNoLedger()}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {onOpenSettings ? (
            <Button size="sm" variant="outline" onClick={onOpenSettings}>
              {controlsSettings()}
            </Button>
          ) : null}
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={busy}>
            {controlsRefresh()}
          </Button>
          <Button size="sm" variant="outline" onClick={onTriage} disabled={busy || !ledger}>
            {controlsTriage()}
          </Button>
          <Button size="sm" disabled={busy || !target} onClick={onNew}>
            {controlsNewEntry()}
          </Button>
          {ledger ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                onConfirm(controlsDeleteLedgerConfirm(), {
                  operation: 'delete-ledger',
                  target: mutationTarget,
                  ifLedgerRevision: ledger.revision,
                  confirmed: true
                })
              }
            >
              {controlsDeleteLedger()}
            </Button>
          ) : null}
        </div>
      </header>
      {ledger?.owner === null ? (
        <section className="flex flex-wrap items-center gap-2 border-b px-6 py-3">
          <Select value={attachTo} onValueChange={onAttachTo}>
            <SelectTrigger aria-label={controlsAttachmentOwner()}>
              <SelectValue placeholder={controlsAttachPlaceholder(ledger.tier)} />
            </SelectTrigger>
            <SelectContent>
              {attachCandidates.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={busy || !attachTo}
            onClick={() =>
              onConfirm(
                controlsAttachConfirm(
                  attachCandidates.find((item) => item.id === attachTo)?.label ?? attachTo
                ),
                {
                  operation: 'attach',
                  target: mutationTarget,
                  attachTo: { tier: ledger.tier, id: attachTo },
                  ifLedgerRevision: ledger.revision,
                  confirmed: true
                }
              )
            }
          >
            {controlsAttach()}
          </Button>
          {catalogError ? (
            <p role="alert" className="text-sm text-destructive">
              {catalogError}
            </p>
          ) : null}
        </section>
      ) : null}
      {ledgerError || error ? (
        <p role="alert" className="px-6 py-3 text-sm text-destructive">
          {ledgerError ?? error}
        </p>
      ) : null}
      {matches.length ? (
        <aside className="border-b px-6 py-3 text-sm">
          {controlsSimilarEntries()}{' '}
          {matches.map((entry) => (
            <Button key={entry.id} variant="link" size="sm" onClick={() => onDetail(entry.id)}>
              {entry.id}: {String(entry.content.title)}
            </Button>
          ))}
        </aside>
      ) : null}
      <section className="flex flex-wrap items-center gap-2 border-b px-6 py-3">
        <Input
          className="w-48"
          aria-label={controlsSearchEntries()}
          placeholder={controlsSearchPlaceholder()}
          value={query}
          onChange={(event) => onFilterChange('query', event.target.value)}
        />
        <Select value={type} onValueChange={(value) => onFilterChange('type', value)}>
          <SelectTrigger size="sm" aria-label={controlsTypeFilter()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{controlsAllTypes()}</SelectItem>
            {types.map((item) => (
              <SelectItem key={item} value={item}>
                {item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={state} onValueChange={(value) => onFilterChange('state', value)}>
          <SelectTrigger size="sm" aria-label={controlsStateFilter()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{controlsAllStates()}</SelectItem>
            {states.map((item) => (
              <SelectItem key={item} value={item}>
                {item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={reviewed} onValueChange={(value) => onFilterChange('reviewed', value)}>
          <SelectTrigger size="sm" aria-label={controlsReviewFilter()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{controlsReviewedAll()}</SelectItem>
            <SelectItem value="yes">{controlsReviewed()}</SelectItem>
            <SelectItem value="no">{controlsUnreviewed()}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={stale} onValueChange={(value) => onFilterChange('stale', value)}>
          <SelectTrigger size="sm" aria-label={controlsStaleFilter()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{controlsStaleAll()}</SelectItem>
            <SelectItem value="yes">{controlsStale()}</SelectItem>
            <SelectItem value="no">{controlsNotStale()}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(value) => onFilterChange('sort', value)}>
          <SelectTrigger size="sm" aria-label={controlsSortLabel()}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="updated">{controlsSortUpdated()}</SelectItem>
            <SelectItem value="sequence">{controlsSortSequence()}</SelectItem>
            <SelectItem value="title">{controlsSortTitle()}</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="w-40"
          aria-label={controlsWorkspaceFilter()}
          placeholder={controlsWorkspacePlaceholder()}
          value={workspace}
          onChange={(event) => onFilterChange('workspace', event.target.value)}
        />
        <Input
          className="w-36"
          aria-label={controlsBranchFilter()}
          placeholder={controlsBranchPlaceholder()}
          value={branch}
          onChange={(event) => onFilterChange('branch', event.target.value)}
        />
        {selected.size ? (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                onMutate({
                  operation: 'approve',
                  target: mutationTarget,
                  selections: [...selected].map(([id, revision]) => ({ id, revision }))
                })
              }
            >
              {controlsReviewSelected(selected.size)}
            </Button>
            {(['resolved', 'archived'] as const).map((next) => (
              <Button
                key={next}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  onConfirm(controlsBulkStateConfirm(selected.size, next), {
                    operation: 'bulk-state',
                    target: mutationTarget,
                    state: next,
                    selections: [...selected].map(([id, revision]) => ({ id, revision })),
                    confirmed: true
                  })
                }
              >
                {controlsBulkState(next)}
              </Button>
            ))}
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                onConfirm(controlsDeleteSelectedConfirm(selected.size), {
                  operation: 'delete-entries',
                  target: mutationTarget,
                  selections: [...selected].map(([id, revision]) => ({ id, revision })),
                  confirmed: true
                })
              }
            >
              {controlsDeleteSelected()}
            </Button>
          </>
        ) : null}
      </section>
    </>
  )
}
