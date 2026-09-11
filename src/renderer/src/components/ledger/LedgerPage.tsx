import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  LedgerEntry,
  LedgerEntryType,
  LedgerFilters,
  LedgerOwner,
  LedgerRequest,
  LedgerState,
  LedgerTarget
} from '../../../../shared/ledger'
import { useAppStore } from '@/store'
import { readLedgerCatalog } from '@/runtime/runtime-ledger-catalog-client'
import { LedgerEntryDetail } from './LedgerEntryDetail'
import { LedgerEntryForm } from './LedgerEntryForm'
import { LedgerEntryList } from './LedgerEntryList'
import { LedgerConfirmationDialog, type LedgerConfirmation } from './LedgerConfirmationDialog'
import { LedgerPageControls } from './LedgerPageControls'
import { useLedgerOwnerLabels } from './ledger-owner-labels'
import { pageStaleRevisions } from './ledger-page-copy'
import { getLedgerSettingsNavigation } from './ledger-settings-navigation'
import { LedgerTriagePanel } from './LedgerTriagePanel'

export type LedgerPageProps = { target?: LedgerTarget; environmentId?: string; title?: string }
const EMPTY_LEDGER_ENTRIES: readonly LedgerEntry[] = []

export function LedgerPage({
  target,
  environmentId,
  title = 'Ledger'
}: LedgerPageProps): React.JSX.Element {
  const entries = useAppStore((store) => store.ledgerEntries)
  const summary = useAppStore((store) => store.ledgerSummary)
  const loading = useAppStore((store) => store.ledgerLoading)
  const ledgerError = useAppStore((store) => store.ledgerError)
  const selectionKey = useAppStore((store) => store.ledgerSelectionKey)
  const loadLedger = useAppStore((store) => store.loadLedger)
  const ledgerRequest = useAppStore((store) => store.ledgerRequest)
  const openLedgerPage = useAppStore((store) => store.openLedgerPage)
  const openSettingsPage = useAppStore((store) => store.openSettingsPage)
  const openSettingsTarget = useAppStore((store) => store.openSettingsTarget)
  const repos = useAppStore((store) => store.repos)
  const [type, setType] = useState<LedgerEntryType | 'all'>('all')
  const [state, setState] = useState<LedgerState | 'all'>('all')
  const [reviewed, setReviewed] = useState('all')
  const [stale, setStale] = useState('all')
  const [workspace, setWorkspace] = useState('')
  const [branch, setBranch] = useState('')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('updated')
  const [selected, setSelected] = useState<Map<string, number>>(new Map())
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<LedgerEntry | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [triageOpen, setTriageOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [matches, setMatches] = useState<LedgerEntry[]>([])
  const [confirmation, setConfirmation] = useState<LedgerConfirmation | null>(null)
  const [attachTo, setAttachTo] = useState('')
  const [attachCandidates, setAttachCandidates] = useState<(LedgerOwner & { label: string })[]>([])
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const generation = useRef(0)
  const ownerLabels = useLedgerOwnerLabels(environmentId)
  const currentSelection = selectionKey === JSON.stringify([environmentId ?? null, target ?? null])
  const ledger = currentSelection ? summary : null
  const ledgerEntries = currentSelection ? entries : EMPTY_LEDGER_ENTRIES
  const ledgerId = ledger?.ledgerId
  const ledgerOwner = ledger?.owner
  const ledgerTier = ledger?.tier
  const busy = pending || loading || !currentSelection
  const mutationTarget = ledger ? { ledgerId: ledger.ledgerId } : target
  const filters = useMemo<LedgerFilters>(
    () => ({
      ...(type !== 'all' ? { type } : {}),
      ...(state !== 'all' ? { state } : {}),
      ...(reviewed !== 'all' ? { reviewed: reviewed === 'yes' } : {}),
      ...(stale !== 'all' ? { stale: stale === 'yes' } : {}),
      ...(workspace ? { workspaceId: workspace } : {}),
      ...(branch ? { branch } : {})
    }),
    [type, state, reviewed, stale, workspace, branch]
  )
  const refresh = useCallback(
    () => loadLedger({ operation: 'list', target, filters }, environmentId),
    [loadLedger, target, filters, environmentId]
  )
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    const effectGeneration = ++generation.current
    setSelected(new Map())
    setDetailId(null)
    setEditing(null)
    setEditorOpen(false)
    setConfirmation(null)
    setMatches([])
    setError(null)
    setAttachCandidates([])
    setAttachTo('')
    setTriageOpen(false)
    setPending(false)
    setCatalogError(null)
    return () => {
      generation.current = effectGeneration + 1
    }
  }, [environmentId, target])
  useEffect(() => {
    if (!ledgerId || ledgerOwner || !ledgerTier) {
      return
    }
    let disposed = false
    setCatalogError(null)
    void Promise.all([
      readLedgerCatalog(environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }),
      ledgerRequest({ operation: 'catalog' }, environmentId)
    ])
      .then(([catalog, response]) => {
        if (disposed) {
          return
        }
        const occupied = new Set(
          (response.ledgers ?? [])
            .filter((item) => item.tier === ledgerTier)
            .map((item) => item.owner?.id)
        )
        const candidates: (LedgerOwner & { label: string })[] =
          ledgerTier === 'project'
            ? catalog.projects.map((item) => ({
                tier: ledgerTier,
                id: item.id,
                label: item.displayName
              }))
            : catalog.groups.map((item) => ({ tier: ledgerTier, id: item.id, label: item.name }))
        setAttachCandidates(candidates.filter((item) => !occupied.has(item.id)))
      })
      .catch((cause) => {
        if (!disposed) {
          setCatalogError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => {
      disposed = true
    }
  }, [environmentId, ledgerId, ledgerOwner, ledgerTier, ledgerRequest])
  const visible = useMemo(
    () =>
      ledgerEntries
        .filter(
          (entry) =>
            !query ||
            entry.id.includes(query) ||
            String(entry.content.title).toLowerCase().includes(query.toLowerCase())
        )
        .sort((a, b) =>
          sort === 'sequence'
            ? a.sequence - b.sequence
            : sort === 'title'
              ? String(a.content.title).localeCompare(String(b.content.title))
              : b.updatedAt.localeCompare(a.updatedAt)
        ),
    [ledgerEntries, query, sort]
  )
  const settingsNavigation = useMemo(
    () => getLedgerSettingsNavigation(ledger?.owner ?? null, repos),
    [ledger?.owner, repos]
  )
  const perform = async (request: LedgerRequest): Promise<void> => {
    const expectedGeneration = generation.current
    setPending(true)
    setError(null)
    try {
      const response = await ledgerRequest(request, environmentId)
      if (generation.current !== expectedGeneration) {
        return
      }
      if (request.operation === 'delete-ledger') {
        openLedgerPage({ environmentId })
        return
      }
      if (response.matches) {
        setMatches(response.matches)
      }
      setSelected(new Map())
      await refresh()
    } catch (cause) {
      if (generation.current === expectedGeneration) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      throw cause
    } finally {
      if (generation.current === expectedGeneration) {
        setPending(false)
      }
    }
  }
  const mutate = async (request: LedgerRequest): Promise<boolean> => {
    try {
      await perform(request)
      return true
    } catch {
      return false
    }
  }
  const edit = (entry: LedgerEntry) => {
    setDetailId(null)
    setEditing(entry)
    setEditorOpen(true)
    setError(null)
  }
  const confirm = (message: string, request: LedgerRequest) => {
    setError(null)
    setConfirmation({
      message,
      request,
      entries: ledgerEntries.filter((entry) =>
        request.selections?.some((item) => item.id === entry.id)
      )
    })
  }
  const submitConfirmation = async () => {
    if (!confirmation || pending || confirmation.blocked) {
      return
    }
    const snapshot = confirmation
    try {
      await perform(snapshot.request)
      setConfirmation(null)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : undefined
      if (code !== 'conflict') {
        setConfirmation({ ...snapshot, error: message })
        return
      }
      try {
        const response = await ledgerRequest(
          { operation: 'list', target: snapshot.request.target },
          environmentId
        )
        const freshEntries = response.entries ?? []
        const ids = snapshot.request.selections?.map((item) => item.id) ?? []
        const refreshed = freshEntries.filter((entry) => ids.includes(entry.id))
        setConfirmation({
          ...snapshot,
          error: pageStaleRevisions(message),
          blocked: refreshed.length !== ids.length,
          entries: refreshed,
          request: {
            ...snapshot.request,
            ...(snapshot.request.selections
              ? {
                  selections: refreshed.map((entry) => ({ id: entry.id, revision: entry.revision }))
                }
              : {}),
            ...(snapshot.request.ifLedgerRevision !== undefined
              ? { ifLedgerRevision: response.ledger?.revision }
              : {})
          }
        })
        await refresh()
      } catch {
        setConfirmation({ ...snapshot, error: message, blocked: true })
      }
    }
  }
  const updateFilter = (key: string, value: string) =>
    (
      ({
        type: setType,
        state: setState,
        reviewed: setReviewed,
        stale: setStale,
        workspace: setWorkspace,
        branch: setBranch,
        query: setQuery,
        sort: setSort
      })[key] as (next: string) => void
    )(value)
  return (
    <main className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      <LedgerPageControls
        title={title}
        ledger={ledger}
        ownerLabel={ownerLabels.lookup(ledger?.owner ?? ledger?.formerOwner)}
        target={target}
        busy={busy}
        ledgerError={ledgerError}
        error={error}
        matches={matches}
        attachTo={attachTo}
        attachCandidates={attachCandidates}
        catalogError={catalogError}
        type={type}
        state={state}
        reviewed={reviewed}
        stale={stale}
        workspace={workspace}
        branch={branch}
        sort={sort}
        query={query}
        selected={selected}
        filters={filters}
        onOpen={() => openLedgerPage({ environmentId })}
        onOpenSettings={
          settingsNavigation
            ? () => {
                openSettingsTarget(settingsNavigation)
                openSettingsPage()
              }
            : null
        }
        onRefresh={() => void refresh()}
        onTriage={() => setTriageOpen(true)}
        onNew={() => {
          setEditing(null)
          setError(null)
          setEditorOpen(true)
        }}
        onConfirm={confirm}
        onAttachTo={setAttachTo}
        onFilterChange={updateFilter}
        onDetail={setDetailId}
        onMutate={(request) => void mutate(request)}
      />
      <LedgerEntryList
        entries={visible}
        selected={selected}
        busy={busy}
        target={mutationTarget}
        onSelect={(entry, checked) =>
          setSelected((current) => {
            const next = new Map(current)
            if (checked) {
              next.set(entry.id, entry.revision)
            } else {
              next.delete(entry.id)
            }
            return next
          })
        }
        onDetail={setDetailId}
        onEdit={edit}
        onMutate={(request) => void mutate(request)}
        onConfirm={confirm}
      />
      <LedgerEntryForm
        open={editorOpen}
        onOpenChange={setEditorOpen}
        entry={editing}
        environmentId={environmentId}
        onSubmit={(entryType, content) =>
          perform(
            editing
              ? {
                  operation: 'edit',
                  target: mutationTarget,
                  id: editing.id,
                  ifRevision: editing.revision,
                  content
                }
              : { operation: 'file', target, type: entryType, content }
          )
        }
      />
      <LedgerEntryDetail
        entry={ledgerEntries.find((entry) => entry.id === detailId) ?? null}
        onClose={() => setDetailId(null)}
        onEdit={edit}
        onMutate={mutate}
        target={mutationTarget}
        error={error}
        pending={pending}
      />
      <LedgerTriagePanel
        open={triageOpen}
        onOpenChange={setTriageOpen}
        target={mutationTarget}
        environmentId={environmentId}
        filters={filters}
        onChanged={refresh}
      />
      <LedgerConfirmationDialog
        confirmation={confirmation}
        pending={pending}
        onOpenChange={(open) => {
          if (!open && !pending) {
            setConfirmation(null)
          }
        }}
        onConfirm={() => void submitConfirmation()}
      />
    </main>
  )
}

export default LedgerPage
