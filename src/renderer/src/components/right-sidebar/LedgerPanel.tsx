import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus, RefreshCw } from 'lucide-react'
import type { LedgerEntry, LedgerFilters, LedgerRequest } from '../../../../shared/ledger'
import { getActiveSidebarWorkspaceId } from '../../../../shared/workspace-scope'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LedgerEntryDetail } from '../ledger/LedgerEntryDetail'
import { LedgerEntryForm } from '../ledger/LedgerEntryForm'
import { LedgerTriagePanel } from '../ledger/LedgerTriagePanel'
import { useLedgerRequest } from '../ledger/use-ledger-request'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'
import {
  getLedgerPanelFilters,
  getLedgerPanelScope,
  getLedgerPanelTarget,
  getLedgerPanelTiers,
  isLedgerEntryFiledHere,
  type LedgerPanelScope,
  type LedgerPanelTier
} from './ledger-panel-scope'
import { LedgerPanelScopeTabs, ledgerPanelTierLabel } from './LedgerPanelScopeTabs'
import { getLedgerPanelWorkspaceIdentity } from './ledger-panel-workspace-identity'
import { getLedgerPanelState, type LedgerPanelState } from './ledger-panel-state'
import { LedgerPanelRow } from './LedgerPanelRow'
import { useLedgerOwnerName } from './use-ledger-owner-name'
import { LedgerPanelFilters } from './LedgerPanelFilters'

function stateMessage(state: LedgerPanelState): string | null {
  switch (state.kind) {
    case 'no-workspace':
      return translate('ledger.panel.noWorkspace', 'Open a workspace to see its ledger.')
    case 'loading':
      return translate('ledger.panel.loading', 'Loading ledger…')
    case 'empty':
      return translate('ledger.panel.empty', 'No entries match this view.')
    case 'owner-ambiguous':
      return translate(
        'ledger.panel.ownerAmbiguous',
        'Ledger scope could not be resolved to a single project.'
      )
    case 'group-missing':
      return translate('ledger.panel.groupMissing', 'This workspace has no group.')
    case 'workspace-missing':
      return translate(
        'ledger.panel.workspaceMissing',
        'This workspace is not live in this runtime.'
      )
    case 'owner-missing':
      return translate('ledger.panel.ownerMissing', 'The owning project or group no longer exists.')
    case 'error':
      return state.message || translate('ledger.panel.failed', 'Ledger could not be loaded.')
    case 'entries':
      return null
  }
}

export default function LedgerPanel({ isVisible }: { isVisible: boolean }): React.JSX.Element {
  const workspaceId = useAppStore((state) =>
    getActiveSidebarWorkspaceId(state.activeWorkspaceKey, state.activeWorktreeId)
  )
  const environmentId = useAppStore(
    (state) =>
      getRightSidebarWorktreeRuntimeSettings(
        getActiveSidebarWorkspaceId(state.activeWorkspaceKey, state.activeWorktreeId)
      ).activeRuntimeEnvironmentId
  )
  const { name: workspaceName, hasGroup } = useAppStore(
    useShallow((state) => getLedgerPanelWorkspaceIdentity(workspaceId, state))
  )
  const scope = useMemo(
    () => getLedgerPanelScope(workspaceId, { activeRuntimeEnvironmentId: environmentId }, hasGroup),
    [workspaceId, environmentId, hasGroup]
  )
  return (
    <ScopedLedgerPanel
      key={JSON.stringify([workspaceId, environmentId])}
      scope={scope}
      workspaceName={workspaceName}
      isVisible={isVisible}
    />
  )
}

function ScopedLedgerPanel({
  scope,
  workspaceName,
  isVisible
}: {
  scope: LedgerPanelScope | null
  workspaceName: string | null
  isVisible: boolean
}): React.JSX.Element {
  const [selectedTier, setTier] = useState<LedgerPanelTier>('workspace')
  const [filters, setFilters] = useState<LedgerFilters>({})
  const [query, setQuery] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)
  const [editing, setEditing] = useState<LedgerEntry | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [triageOpen, setTriageOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [showSpinner, setShowSpinner] = useState(false)
  const tiers = getLedgerPanelTiers(scope)
  // Why: group membership arrives after hydration, so a selected tier can stop being offered.
  const tier = tiers.includes(selectedTier) ? selectedTier : 'workspace'
  const target = useMemo(() => (scope ? getLedgerPanelTarget(scope, tier) : null), [scope, tier])
  const scopedFilters = useMemo(
    () => (scope ? getLedgerPanelFilters(scope, tier, filters) : filters),
    [scope, tier, filters]
  )
  const { ledger, entries, loading, error, perform, refresh } = useLedgerRequest({
    target,
    environmentId: scope?.environmentId,
    isVisible,
    filters: scopedFilters
  })
  const ownerName = useLedgerOwnerName(ledger?.owner ?? null, scope?.environmentId, isVisible)
  useEffect(() => {
    if (!loading) {
      setShowSpinner(false)
      return
    }
    const timer = setTimeout(() => setShowSpinner(true), 200)
    return () => clearTimeout(timer)
  }, [loading])
  useEffect(() => {
    if (!isVisible) {
      setDetailId(null)
      setFormOpen(false)
      setTriageOpen(false)
    }
  }, [isVisible])
  const matches = entries.filter((entry) =>
    `${entry.id} ${String(entry.content.title ?? '')}`
      .toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase())
  )
  const state = getLedgerPanelState({
    loading,
    error,
    entries: matches,
    hasWorkspace: Boolean(scope)
  })
  const message = stateMessage(state)
  const failed = !['no-workspace', 'loading', 'empty', 'entries'].includes(state.kind)
  const busy = loading || pending
  const detail = entries.find((entry) => entry.id === detailId) ?? null
  const openNew = () => {
    setEditing(null)
    setFormOpen(true)
  }
  const mutate = async (request: LedgerRequest): Promise<boolean> => {
    setPending(true)
    setMutationError(null)
    try {
      await perform(request)
      return true
    } catch (cause) {
      setMutationError(
        cause instanceof Error
          ? cause.message
          : translate('ledger.panel.mutationFailed', 'Ledger change failed.')
      )
      return false
    } finally {
      setPending(false)
    }
  }
  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 space-y-2 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">{translate('ledger.panel.title', 'Ledger')}</h2>
          <div className="flex items-center gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={busy || !scope}
                  aria-label={translate('ledger.panel.refresh', 'Refresh ledger')}
                  onClick={() => void refresh().catch(() => {})}
                >
                  <RefreshCw
                    className={loading && showSpinner ? 'size-3.5 animate-spin' : 'size-3.5'}
                  />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{translate('ledger.panel.refresh', 'Refresh ledger')}</TooltipContent>
            </Tooltip>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy || !ledger || failed}
              onClick={() => setTriageOpen(true)}
            >
              {translate('ledger.panel.triage', 'Triage')}
            </Button>
            <Button size="xs" disabled={busy || !scope || failed} onClick={openNew}>
              <Plus />
              {translate('ledger.panel.new', 'New')}
            </Button>
          </div>
        </div>
        <LedgerPanelScopeTabs
          tiers={tiers}
          value={tier}
          isFolderWorkspace={Boolean(scope?.isFolderWorkspace)}
          disabled={!scope}
          onChange={(next) => {
            setDetailId(null)
            setTier(next)
          }}
        />
        {ledger ? (
          <p className="break-words text-xs text-muted-foreground">
            {ledger.tier === 'project'
              ? translate('ledger.panel.project', 'Project')
              : translate('ledger.panel.group', 'Group')}
            {' · '}
            {ownerName ?? ledger.owner?.id ?? translate('ledger.panel.detached', 'Detached')}
            {tier === 'workspace' ? (
              <>
                <br />
                {translate('ledger.panel.filedIn', 'Filed in')}{' '}
                {workspaceName ??
                  ledgerPanelTierLabel(tier, Boolean(scope?.isFolderWorkspace)).toLocaleLowerCase()}
              </>
            ) : null}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <Input
            className="h-7 min-w-0 text-xs"
            aria-label={translate('ledger.panel.search', 'Search ledger')}
            placeholder={translate('ledger.panel.searchPlaceholder', 'Search title or ID')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            disabled={!scope}
          />
          <LedgerPanelFilters filters={filters} onChange={setFilters} />
        </div>
      </header>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto" aria-busy={loading}>
        {message ? (
          <div
            className="space-y-2 px-4 py-4 text-xs text-muted-foreground"
            role={failed ? 'alert' : 'status'}
          >
            <p className="flex items-center gap-2">
              {state.kind === 'loading' && showSpinner ? (
                <Loader2 className="size-4 animate-spin" />
              ) : null}
              {message}
            </p>
            {state.kind === 'empty' ? (
              <Button size="xs" onClick={openNew} disabled={busy}>
                {translate('ledger.panel.newEntry', 'New entry')}
              </Button>
            ) : null}
            {failed ? (
              <Button
                variant="outline"
                size="xs"
                disabled={loading}
                onClick={() => void refresh().catch(() => {})}
              >
                {translate('ledger.panel.retry', 'Retry')}
              </Button>
            ) : null}
          </div>
        ) : (
          matches.map((entry) => (
            <LedgerPanelRow
              key={entry.id}
              entry={entry}
              filedHere={
                tier !== 'workspace' &&
                isLedgerEntryFiledHere(entry.origin, scope?.workspaceId ?? null)
              }
              onOpen={(selected) => {
                setMutationError(null)
                setDetailId(selected.id)
              }}
            />
          ))
        )}
      </div>
      {scope && target && isVisible ? (
        <>
          <LedgerEntryDetail
            entry={detail}
            onClose={() => setDetailId(null)}
            onEdit={(entry) => {
              setEditing(entry)
              setFormOpen(true)
            }}
            target={target}
            onMutate={mutate}
            pending={pending}
            error={mutationError}
          />
          <LedgerEntryForm
            open={formOpen}
            onOpenChange={setFormOpen}
            entry={editing}
            environmentId={scope.environmentId}
            onSubmit={async (type, content) => {
              await perform(
                editing
                  ? { operation: 'edit', id: editing.id, ifRevision: editing.revision, content }
                  : { operation: 'file', type, content }
              )
              setFormOpen(false)
            }}
          />
          <LedgerTriagePanel
            open={triageOpen}
            onOpenChange={setTriageOpen}
            target={target}
            environmentId={scope.environmentId}
            filters={scopedFilters}
            onChanged={refresh}
          />
        </>
      ) : null}
    </section>
  )
}
