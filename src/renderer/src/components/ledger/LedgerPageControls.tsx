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

const types: LedgerEntryType[] = ['bug', 'deferred', 'test-gap', 'proposal', 'decision']
const states: LedgerState[] = ['open', 'resolved', 'archived']

export type LedgerPageControlsProps = {
  title: string
  ledger: LedgerSummary | null
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
  staleDays: string
  filters: LedgerFilters
  onOpen: () => void
  onRefresh: () => void
  onTriage: () => void
  onNew: () => void
  onConfirm: (message: string, request: LedgerRequest) => void
  onAttachTo: (value: string) => void
  onFilterChange: (key: string, value: string) => void
  onDetail: (id: string) => void
  onMutate: (request: LedgerRequest) => void
  onStaleDays: (value: string) => void
}

export function LedgerPageControls({
  title,
  ledger,
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
  staleDays,
  onOpen,
  onRefresh,
  onTriage,
  onNew,
  onConfirm,
  onAttachTo,
  onFilterChange,
  onDetail,
  onMutate,
  onStaleDays
}: LedgerPageControlsProps): React.JSX.Element {
  const mutationTarget = ledger ? { ledgerId: ledger.ledgerId } : target
  return (
    <>
      <header className="flex shrink-0 flex-wrap items-start justify-between gap-3 border-b px-6 py-4">
        <div className="min-w-0">
          <Button variant="link" size="sm" onClick={onOpen}>
            Open ledger
          </Button>
          <h1 className="text-lg font-semibold">{title}</h1>
          {ledger ? (
            <p className="break-words text-xs text-muted-foreground">
              {ledger.tier} · {ledger.ledgerId} · runtime {ledger.runtime.runtimeId} · profile{' '}
              {ledger.runtime.profileId} · revision {ledger.revision}
              <br />
              {ledger.owner
                ? `Owner ${ledger.owner.id}`
                : `Detached · former owner ${ledger.formerOwner?.id ?? 'unknown'}`}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">This owner has no ledger yet.</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={busy}>
            Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={onTriage} disabled={busy || !ledger}>
            Triage
          </Button>
          <Button size="sm" disabled={busy || !target} onClick={onNew}>
            New entry
          </Button>
          {ledger ? (
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                onConfirm('Permanently delete this ledger, every entry body, and all history?', {
                  operation: 'delete-ledger',
                  target: mutationTarget,
                  ifLedgerRevision: ledger.revision,
                  confirmed: true
                })
              }
            >
              Delete ledger
            </Button>
          ) : null}
        </div>
      </header>
      {ledger?.owner === null ? (
        <section className="flex flex-wrap items-center gap-2 border-b px-6 py-3">
          <Select value={attachTo} onValueChange={onAttachTo}>
            <SelectTrigger aria-label="Attachment owner">
              <SelectValue placeholder={`Attach ${ledger.tier}`} />
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
                `Attach ${attachCandidates.find((item) => item.id === attachTo)?.label ?? attachTo}? Project attachment asserts the same codebase.`,
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
            Attach
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
          Similar entries (advisory):{' '}
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
          aria-label="Search entries"
          placeholder="Search title or ID"
          value={query}
          onChange={(event) => onFilterChange('query', event.target.value)}
        />
        <Select value={type} onValueChange={(value) => onFilterChange('type', value)}>
          <SelectTrigger size="sm" aria-label="Entry type filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            {types.map((item) => (
              <SelectItem key={item} value={item}>
                {item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={state} onValueChange={(value) => onFilterChange('state', value)}>
          <SelectTrigger size="sm" aria-label="Entry state filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All states</SelectItem>
            {states.map((item) => (
              <SelectItem key={item} value={item}>
                {item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={reviewed} onValueChange={(value) => onFilterChange('reviewed', value)}>
          <SelectTrigger size="sm" aria-label="Review filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Reviewed: all</SelectItem>
            <SelectItem value="yes">Reviewed</SelectItem>
            <SelectItem value="no">Unreviewed</SelectItem>
          </SelectContent>
        </Select>
        <Select value={stale} onValueChange={(value) => onFilterChange('stale', value)}>
          <SelectTrigger size="sm" aria-label="Stale filter">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Stale: all</SelectItem>
            <SelectItem value="yes">Stale</SelectItem>
            <SelectItem value="no">Not stale</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(value) => onFilterChange('sort', value)}>
          <SelectTrigger size="sm" aria-label="Entry sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="updated">Newest activity</SelectItem>
            <SelectItem value="sequence">Sequence</SelectItem>
            <SelectItem value="title">Title</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="w-40"
          aria-label="Origin workspace filter"
          placeholder="Origin workspace"
          value={workspace}
          onChange={(event) => onFilterChange('workspace', event.target.value)}
        />
        <Input
          className="w-36"
          aria-label="Origin branch filter"
          placeholder="Origin branch"
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
              Review ({selected.size})
            </Button>
            {(['resolved', 'archived'] as const).map((next) => (
              <Button
                key={next}
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  onConfirm(`Set ${selected.size} displayed entries to ${next}?`, {
                    operation: 'bulk-state',
                    target: mutationTarget,
                    state: next,
                    selections: [...selected].map(([id, revision]) => ({ id, revision })),
                    confirmed: true
                  })
                }
              >
                {next === 'resolved' ? 'Resolve selected' : 'Archive selected'}
              </Button>
            ))}
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() =>
                onConfirm(`Permanently delete ${selected.size} entries and their histories?`, {
                  operation: 'delete-entries',
                  target: mutationTarget,
                  selections: [...selected].map(([id, revision]) => ({ id, revision })),
                  confirmed: true
                })
              }
            >
              Delete selected
            </Button>
          </>
        ) : null}
      </section>
      {ledger ? (
        <section className="flex items-center gap-2 border-b px-6 py-2">
          <label htmlFor="ledger-stale-days" className="text-sm">
            Stale after days
          </label>
          <Input
            id="ledger-stale-days"
            type="number"
            min={0}
            className="w-24"
            value={staleDays}
            onChange={(event) => onStaleDays(event.target.value)}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={
              busy ||
              !staleDays.trim() ||
              !Number.isSafeInteger(Number(staleDays)) ||
              Number(staleDays) < 0
            }
            onClick={() =>
              onMutate({
                operation: 'settings',
                target: mutationTarget,
                ifLedgerRevision: ledger.revision,
                staleAfterDays: Number(staleDays)
              })
            }
          >
            Save threshold
          </Button>
        </section>
      ) : null}
    </>
  )
}
