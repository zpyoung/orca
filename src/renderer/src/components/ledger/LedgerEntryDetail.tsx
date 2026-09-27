import { useEffect, useMemo, useState } from 'react'
import { Check, Pencil, RotateCcw } from 'lucide-react'
import type {
  LedgerActor,
  LedgerChange,
  LedgerEntry,
  LedgerLocation,
  LedgerRequest,
  LedgerState,
  LedgerTarget
} from '../../../../shared/ledger'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  detailAfter,
  detailBefore,
  detailChangedFields,
  detailClose,
  detailContentSection,
  detailEdit,
  detailEntrySection,
  detailFullHistory,
  detailHistoryRevision,
  detailLatestActor,
  detailModel,
  detailOriginSection,
  detailProviderSession,
  detailRevert,
  detailRevertLabel,
  detailRevertPlaceholder,
  detailReview,
  detailReviewedBadge,
  detailRevisionCount,
  detailRevisionOption,
  detailSummaryLine
} from './ledger-entry-detail-copy'

export type LedgerEntryDetailProps = {
  entry: LedgerEntry | null
  onClose: () => void
  onEdit: (entry: LedgerEntry) => void
  onMutate: (request: LedgerRequest) => Promise<boolean>
  target?: LedgerTarget
  error?: string | null
  pending?: boolean
}

function actorLabel(actor: LedgerActor): string {
  const identity = actor.model ?? actor.providerSessionId ?? actor.tool
  return identity ? `${actor.kind} · ${identity}` : actor.kind
}

function readable(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (value === null || value === undefined) {
    return '—'
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function locationText(location: LedgerLocation): string {
  const line = location.line === undefined ? '' : `:${location.line}`
  const base = `${location.base.kind} ${location.base.id}`
  const host = location.host ?? location.base.host
  return `${location.path}${line} · ${base}${host ? ` · ${host}` : ''}${location.external ? ' · external' : ''}`
}

function ContentValue({ name, value }: { name: string; value: unknown }): React.JSX.Element {
  const location =
    value && typeof value === 'object' && 'path' in value && 'base' in value
      ? (value as LedgerLocation)
      : null
  return (
    <div className="grid gap-1 border-b py-2 last:border-b-0">
      <dt className="text-xs font-medium text-muted-foreground">{name}</dt>
      <dd className={location ? 'text-sm' : 'whitespace-pre-wrap break-words font-mono text-xs'}>
        {location ? locationText(location) : readable(value)}
      </dd>
    </div>
  )
}

function HistoryItem({ change }: { change: LedgerChange }): React.JSX.Element {
  return (
    <article className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="outline">{detailHistoryRevision(change.revision)}</Badge>
        <span className="text-muted-foreground">{actorLabel(change.actor)}</span>
        <span className="text-muted-foreground">{new Date(change.at).toLocaleString()}</span>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{detailChangedFields(change)}</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <details className="rounded border bg-muted/30 p-2">
          <summary className="cursor-pointer text-xs font-medium">{detailBefore()}</summary>
          <pre className="mt-2 max-h-48 overflow-auto scrollbar-sleek whitespace-pre-wrap break-words font-mono text-[11px]">
            {readable(change.before)}
          </pre>
        </details>
        <details className="rounded border bg-muted/30 p-2">
          <summary className="cursor-pointer text-xs font-medium">{detailAfter()}</summary>
          <pre className="mt-2 max-h-48 overflow-auto scrollbar-sleek whitespace-pre-wrap break-words font-mono text-[11px]">
            {readable(change.after)}
          </pre>
        </details>
      </div>
    </article>
  )
}

export function LedgerEntryDetail({
  entry,
  onClose,
  onEdit,
  onMutate,
  target,
  error,
  pending = false
}: LedgerEntryDetailProps): React.JSX.Element {
  const [revertRevision, setRevertRevision] = useState('')
  const [mutationError, setMutationError] = useState<string | null>(null)
  const priorRevisions = useMemo(
    () => entry?.history.filter((change) => change.revision < (entry?.revision ?? 0)) ?? [],
    [entry]
  )

  useEffect(() => {
    setRevertRevision('')
    setMutationError(null)
  }, [entry?.id, entry?.revision])

  if (!entry) {
    return (
      <Dialog open={false}>
        <DialogContent />
      </Dialog>
    )
  }

  const mutate = async (request: LedgerRequest) => {
    setMutationError(null)
    const succeeded = await onMutate(request)
    if (!succeeded) {
      setMutationError('The ledger change was rejected. Review the error and try again.')
    }
  }
  const stateRequest = (state: LedgerState): LedgerRequest => ({
    operation: 'state',
    target,
    id: entry.id,
    ifRevision: entry.revision,
    state
  })
  const visibleError = mutationError ?? error ?? null

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <div className="flex flex-wrap items-center gap-2 pr-8">
            <DialogTitle className="font-mono">{entry.id}</DialogTitle>
            <Badge variant="outline">{entry.type}</Badge>
            <Badge variant="secondary">{entry.state}</Badge>
            {entry.reviewed ? <Badge>{detailReviewedBadge()}</Badge> : null}
          </div>
          <DialogDescription>{detailSummaryLine(entry)}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 space-y-5 overflow-y-auto scrollbar-sleek pr-1">
          {visibleError ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {visibleError}
            </div>
          ) : null}

          <section className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {detailEntrySection()}
              </h3>
              <dl className="mt-2">
                <ContentValue name="state" value={entry.state} />
                <ContentValue name="reviewed" value={entry.reviewed ? 'yes' : 'no'} />
                <ContentValue name="created" value={new Date(entry.createdAt).toLocaleString()} />
              </dl>
            </div>
            <div className="rounded-md border p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {detailOriginSection()}
              </h3>
              <dl className="mt-2">
                <ContentValue name="workspace" value={entry.origin.workspaceId} />
                <ContentValue
                  name="owner"
                  value={
                    entry.origin.owner ? `${entry.origin.owner.tier} ${entry.origin.owner.id}` : '—'
                  }
                />
                <ContentValue name="branch" value={entry.origin.branch} />
                <ContentValue name="host" value={entry.origin.host} />
                <ContentValue name="baseline revision" value={entry.origin.revision} />
                <ContentValue
                  name="observed"
                  value={
                    entry.origin.observedAt
                      ? new Date(entry.origin.observedAt).toLocaleString()
                      : undefined
                  }
                />
              </dl>
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold">{detailContentSection()}</h3>
            <dl className="mt-1">
              {Object.entries(entry.content).map(([name, value]) => (
                <ContentValue key={name} name={name} value={value} />
              ))}
            </dl>
          </section>

          <section className="rounded-md border p-3">
            <h3 className="text-sm font-semibold">{detailLatestActor()}</h3>
            <p className="mt-1 text-sm">{actorLabel(entry.latestContentActor)}</p>
            <dl className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              <div>
                <dt>{detailModel()}</dt>
                <dd className="font-mono text-foreground">
                  {entry.latestContentActor.model ?? '—'}
                </dd>
              </div>
              <div>
                <dt>{detailProviderSession()}</dt>
                <dd className="break-all font-mono text-foreground">
                  {entry.latestContentActor.providerSessionId ?? '—'}
                </dd>
              </div>
            </dl>
          </section>

          <section>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{detailFullHistory()}</h3>
              <span className="text-xs text-muted-foreground">
                {detailRevisionCount(entry.history.length)}
              </span>
            </div>
            <div className="mt-2 grid gap-2">
              {entry.history.map((change) => (
                <HistoryItem key={change.revision} change={change} />
              ))}
            </div>
          </section>
        </div>

        <DialogFooter className="flex-wrap items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onClose()
                onEdit(entry)
              }}
              disabled={pending}
            >
              <Pencil className="mr-2 size-4" />
              {detailEdit()}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void mutate({
                  operation: 'approve',
                  target,
                  selections: [{ id: entry.id, revision: entry.revision }]
                })
              }
              disabled={pending || entry.reviewed}
            >
              <Check className="mr-2 size-4" />
              {detailReview()}
            </Button>
            {(['open', 'resolved', 'archived'] as const).map((state) => (
              <Button
                key={state}
                variant={state === entry.state ? 'secondary' : 'outline'}
                size="sm"
                onClick={() => void mutate(stateRequest(state))}
                disabled={pending || state === entry.state}
              >
                {state}
              </Button>
            ))}
            {priorRevisions.length ? (
              <div className="flex gap-2">
                <Select value={revertRevision} onValueChange={setRevertRevision} disabled={pending}>
                  <SelectTrigger size="sm" aria-label={detailRevertLabel()}>
                    <SelectValue placeholder={detailRevertPlaceholder()} />
                  </SelectTrigger>
                  <SelectContent>
                    {priorRevisions.map((change) => (
                      <SelectItem key={change.revision} value={String(change.revision)}>
                        {detailRevisionOption(change.revision)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    void mutate({
                      operation: 'revert',
                      target,
                      id: entry.id,
                      ifRevision: entry.revision,
                      toRevision: Number(revertRevision)
                    })
                  }
                  disabled={pending || !revertRevision}
                >
                  <RotateCcw className="mr-2 size-4" />
                  {detailRevert()}
                </Button>
              </div>
            ) : null}
          </div>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {detailClose()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
