import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Archive, Check, Loader2 } from 'lucide-react'
import type { LedgerFilters, LedgerReviewCandidate, LedgerTarget } from '../../../../shared/ledger'
import { requestLedger } from '@/runtime/runtime-ledger-client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  triageAdvisoryNote,
  triageApprove,
  triageArchive,
  triageBulkDescription,
  triageCancel,
  triageCandidatesLabel,
  triageClose,
  triageConfirmAction,
  triageConfirmRow,
  triageDescription,
  triageEmpty,
  triageEvidenceLine,
  triageHiddenSelections,
  triageLoading,
  triageOriginLine,
  triageReasonLine,
  triageResolve,
  triageSelectEntryLabel,
  triageStaleBadge,
  triageTitle
} from './ledger-triage-panel-copy'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

export type LedgerTriagePanelProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  target?: LedgerTarget
  environmentId?: string
  filters?: LedgerFilters
  onChanged: () => Promise<void>
}

type Selection = { id: string; revision: number }
type Confirmation = {
  state: 'resolved' | 'archived'
  selections: Selection[]
  candidates: LedgerReviewCandidate[]
}

const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause ?? 'Ledger operation failed')
const isConflict = (cause: unknown): boolean => {
  const value = cause as { code?: string; name?: string; message?: string } | null
  return (
    value?.code === 'conflict' ||
    (value?.name === 'LedgerError' && /conflict|stale|revision/i.test(value.message ?? '')) ||
    /conflict|stale|revision/i.test(errorText(cause))
  )
}
const titleOf = (candidate: LedgerReviewCandidate): string =>
  String(candidate.entry.content.title ?? 'Untitled')

export function LedgerTriagePanel({
  open,
  onOpenChange,
  target,
  environmentId,
  filters,
  onChanged
}: LedgerTriagePanelProps): React.JSX.Element {
  const [candidates, setCandidates] = useState<LedgerReviewCandidate[]>([])
  const [selected, setSelected] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const generation = useRef(0)
  const scopeKey = useMemo(
    () => JSON.stringify([target ?? null, environmentId ?? null, filters ?? null]),
    [environmentId, filters, target]
  )

  const loadCandidates = useCallback(
    async (expectedGeneration?: number): Promise<LedgerReviewCandidate[] | null> => {
      const requestGeneration = expectedGeneration ?? ++generation.current
      setLoading(true)
      setError(null)
      try {
        const response = await requestLedger(
          { operation: 'review', target, filters },
          environmentId
        )
        const next = response.candidates ?? []
        if (requestGeneration !== generation.current) {
          return null
        }
        setCandidates(next)
        return next
      } catch (cause) {
        if (requestGeneration === generation.current) {
          setError(errorText(cause))
        }
        return null
      } finally {
        if (requestGeneration === generation.current) {
          setLoading(false)
        }
      }
    },
    [environmentId, filters, target]
  )

  useEffect(() => {
    if (!open) {
      return
    }
    generation.current += 1
    setCandidates([])
    setSelected(new Map())
    setConfirmation(null)
    void loadCandidates(generation.current)
  }, [open, scopeKey, loadCandidates])

  const close = (nextOpen: boolean) => {
    if (!nextOpen && !pending) {
      generation.current += 1
      setConfirmation(null)
      setSelected(new Map())
    }
    onOpenChange(nextOpen)
  }

  const toggle = (candidate: LedgerReviewCandidate, checked: boolean) => {
    setSelected((current) => {
      const next = new Map(current)
      if (checked) {
        next.set(candidate.entry.id, candidate.entry.revision)
      } else {
        next.delete(candidate.entry.id)
      }
      return next
    })
  }

  const snapshot = (): Selection[] => [...selected].map(([id, revision]) => ({ id, revision }))

  const runApprove = async () => {
    const selections = snapshot()
    if (!selections.length || pending) {
      return
    }
    setPending(true)
    setError(null)
    try {
      await requestLedger({ operation: 'approve', target, filters, selections }, environmentId)
      await onChanged()
      setSelected(new Map())
      await loadCandidates()
    } catch (cause) {
      if (isConflict(cause)) {
        setError(`Review changed while you were acting: ${errorText(cause)}`)
        await loadCandidates()
      } else {
        setError(errorText(cause))
      }
    } finally {
      setPending(false)
    }
  }

  const openBulkConfirmation = (state: 'resolved' | 'archived') => {
    const selections = snapshot()
    if (!selections.length || pending) {
      return
    }
    setConfirmation({
      state,
      selections,
      candidates: selections
        .map((selection) => candidates.find((item) => item.entry.id === selection.id))
        .filter((item): item is LedgerReviewCandidate => Boolean(item))
    })
    setError(null)
  }

  const runBulk = async () => {
    if (!confirmation || pending) {
      return
    }
    const currentConfirmation = confirmation
    setPending(true)
    setError(null)
    try {
      await requestLedger(
        {
          operation: 'bulk-state',
          target,
          filters,
          state: currentConfirmation.state,
          selections: currentConfirmation.selections,
          confirmed: true
        },
        environmentId
      )
      await onChanged()
      setConfirmation(null)
      setSelected(new Map())
      await loadCandidates()
    } catch (cause) {
      if (isConflict(cause)) {
        const fresh = await loadCandidates()
        const refreshed = currentConfirmation.selections.map((selection) => {
          const candidate = fresh?.find((item) => item.entry.id === selection.id)
          return candidate
            ? { id: candidate.entry.id, revision: candidate.entry.revision }
            : selection
        })
        setConfirmation({
          ...currentConfirmation,
          selections: refreshed,
          candidates: refreshed
            .map((selection) => fresh?.find((item) => item.entry.id === selection.id))
            .filter((item): item is LedgerReviewCandidate => Boolean(item))
        })
        setError(
          'The displayed entries changed. Review the refreshed revisions below and click the action again; nothing was retried automatically.'
        )
      } else {
        setError(errorText(cause))
      }
    } finally {
      setPending(false)
    }
  }

  const displayedConfirmation = confirmation?.candidates ?? []
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[88vh] overflow-auto scrollbar-sleek sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{triageTitle()}</DialogTitle>
          <DialogDescription>{triageDescription()}</DialogDescription>
        </DialogHeader>
        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            {error}
          </div>
        ) : null}
        {loading ? (
          <div
            role="status"
            className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin" />
            {triageLoading()}
          </div>
        ) : null}
        {!loading && !error && !candidates.length ? (
          <p role="status" className="py-10 text-center text-sm text-muted-foreground">
            {triageEmpty()}
          </p>
        ) : null}
        {!loading && candidates.length ? (
          <div className="grid gap-2" aria-label={triageCandidatesLabel()}>
            {candidates.map((candidate) => {
              const entry = candidate.entry
              return (
                <article key={`${entry.id}:${entry.revision}`} className="rounded-lg border p-3">
                  <div className="flex items-start gap-3">
                    <Checkbox
                      checked={selected.has(entry.id)}
                      onCheckedChange={(checked) => toggle(candidate, checked === true)}
                      disabled={pending}
                      aria-label={triageSelectEntryLabel(entry.id, entry.revision)}
                    />
                    <div className="min-w-0 flex-1 space-y-2 break-words">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-sm">{entry.id}</span>
                        <Badge variant="outline">{entry.type}</Badge>
                        <Badge variant="secondary">{entry.state}</Badge>
                        {candidate.stale ? (
                          <Badge variant="outline">{triageStaleBadge()}</Badge>
                        ) : null}
                      </div>
                      <p className="font-medium">{titleOf(candidate)}</p>
                      <p className="text-xs text-muted-foreground">{triageReasonLine(candidate)}</p>
                      <p className="text-xs text-muted-foreground">{triageOriginLine(candidate)}</p>
                      <p className="text-xs text-muted-foreground">
                        {triageEvidenceLine(candidate)}
                      </p>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        ) : null}
        <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          {triageAdvisoryNote()}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={pending}>
            {triageClose()}
          </Button>
          <Button
            variant="outline"
            onClick={() => void runApprove()}
            disabled={pending || !selected.size || loading}
          >
            <Check className="mr-2 size-4" />
            {triageApprove(selected.size)}
          </Button>
          <Button
            variant="outline"
            onClick={() => openBulkConfirmation('resolved')}
            disabled={pending || !selected.size || loading}
          >
            {triageResolve()}
          </Button>
          <Button
            variant="destructive"
            onClick={() => openBulkConfirmation('archived')}
            disabled={pending || !selected.size || loading}
          >
            <Archive className="mr-2 size-4" />
            {triageArchive()}
          </Button>
        </DialogFooter>
      </DialogContent>
      <Dialog
        open={Boolean(confirmation)}
        onOpenChange={(value) => {
          if (!value && !pending) {
            setConfirmation(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{triageConfirmAction(confirmation?.state)}</DialogTitle>
            <DialogDescription>{triageBulkDescription()}</DialogDescription>
          </DialogHeader>
          {error ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}
          <div className="max-h-64 overflow-auto scrollbar-sleek rounded-md border p-3 text-sm">
            <ul className="grid gap-2">
              {displayedConfirmation.map((candidate) => (
                <li key={candidate.entry.id} className="font-mono">
                  {triageConfirmRow(
                    candidate.entry.id,
                    titleOf(candidate),
                    candidate.entry.revision
                  )}
                </li>
              ))}
              {confirmation && displayedConfirmation.length < confirmation.selections.length ? (
                <li className="text-destructive">{triageHiddenSelections()}</li>
              ) : null}
            </ul>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmation(null)} disabled={pending}>
              {triageCancel()}
            </Button>
            <Button
              variant={confirmation?.state === 'archived' ? 'destructive' : 'default'}
              onClick={() => void runBulk()}
              disabled={pending || !confirmation?.selections.length}
            >
              {pending ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
              {triageConfirmAction(confirmation?.state)}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  )
}

export default LedgerTriagePanel
