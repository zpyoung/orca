import { useCallback, useEffect, useRef, useState } from 'react'
import type { LedgerSummary } from '../../../../shared/ledger'
import type { Repo } from '../../../../shared/types'
import { getProjectIdentityKey } from '../../../../shared/project-host-setup-projection'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { getRepositoryLedgerSectionId } from './repository-settings-targets'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

function isValidThreshold(value: string): boolean {
  const parsed = Number(value)
  return value.trim().length > 0 && Number.isSafeInteger(parsed) && parsed >= 0
}

/** Edits the project ledger's own staleness threshold; a project with no ledger yet has nothing to set. */
export function RepositoryLedgerSection({
  repo,
  forceVisible
}: {
  repo: Repo
  forceVisible: boolean
}): React.JSX.Element {
  const ledgerRequest = useAppStore((state) => state.ledgerRequest)
  const [ledger, setLedger] = useState<LedgerSummary | null>(null)
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const generation = useRef(0)
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  const environmentId = host?.kind === 'runtime' ? host.id : undefined
  const projectId = getProjectIdentityKey(repo)

  const load = useCallback(async () => {
    const requestGeneration = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const response = await ledgerRequest(
        { operation: 'list', target: { owner: { tier: 'project', id: projectId } } },
        environmentId
      )
      if (requestGeneration !== generation.current) {
        return
      }
      setLedger(response.ledger)
      setDraft(response.ledger ? String(response.ledger.staleAfterDays) : '')
    } catch (cause) {
      if (requestGeneration !== generation.current) {
        return
      }
      setLedger(null)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (requestGeneration === generation.current) {
        setLoading(false)
      }
    }
  }, [environmentId, ledgerRequest, projectId])

  useEffect(() => {
    void load()
  }, [load])

  const save = async () => {
    if (!ledger) {
      return
    }
    const requestGeneration = generation.current
    setPending(true)
    setError(null)
    setSaved(false)
    try {
      const response = await ledgerRequest(
        {
          operation: 'settings',
          target: { ledgerId: ledger.ledgerId },
          ifLedgerRevision: ledger.revision,
          staleAfterDays: Number(draft)
        },
        environmentId
      )
      if (requestGeneration !== generation.current) {
        return
      }
      setLedger(response.ledger)
      setSaved(true)
    } catch (cause) {
      if (requestGeneration !== generation.current) {
        return
      }
      setError(cause instanceof Error ? cause.message : String(cause))
      await load()
    } finally {
      if (requestGeneration === generation.current) {
        setPending(false)
      }
    }
  }

  const unchanged = ledger ? Number(draft) === ledger.staleAfterDays : true
  return (
    <SearchableSetting
      title={translate('settings.repository.ledger.staleTitle', 'Ledger Staleness')}
      description={translate(
        'settings.repository.ledger.staleDescription',
        'How many days without activity before a ledger entry is flagged stale for review.'
      )}
      keywords={[repo.displayName, 'ledger', 'stale', 'triage']}
      className="space-y-2"
      id={getRepositoryLedgerSectionId(repo.id)}
      forceVisible={forceVisible}
    >
      <Label
        htmlFor={`${getRepositoryLedgerSectionId(repo.id)}-days`}
        className="text-sm font-semibold"
      >
        {translate('settings.repository.ledger.staleTitle', 'Ledger Staleness')}
      </Label>
      <p className="text-sm text-muted-foreground">
        {translate(
          'settings.repository.ledger.staleDescription',
          'How many days without activity before a ledger entry is flagged stale for review.'
        )}
      </p>
      {loading ? (
        <p className="text-sm text-muted-foreground">
          {translate('settings.repository.ledger.loading', 'Reading this project’s ledger…')}
        </p>
      ) : ledger ? (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={`${getRepositoryLedgerSectionId(repo.id)}-days`}
            type="number"
            min={0}
            className="w-24"
            value={draft}
            disabled={pending}
            onChange={(event) => {
              setSaved(false)
              setDraft(event.target.value)
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={pending || unchanged || !isValidThreshold(draft)}
            onClick={() => void save()}
          >
            {translate('settings.repository.ledger.save', 'Save')}
          </Button>
          {saved && unchanged ? (
            <span className="text-sm text-muted-foreground">
              {translate('settings.repository.ledger.saved', 'Saved')}
            </span>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {translate(
            'settings.repository.ledger.noLedger',
            'This project has no ledger yet. File an entry to create one.'
          )}
        </p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </SearchableSetting>
  )
}
