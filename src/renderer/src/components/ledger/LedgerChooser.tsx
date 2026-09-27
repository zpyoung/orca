import { useCallback, useEffect, useRef, useState } from 'react'
import { Archive, FolderOpen, RefreshCw } from 'lucide-react'
import type { LedgerSummary } from '../../../../shared/ledger'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useAppStore } from '@/store'
import {
  chooserCatalogError,
  chooserEmpty,
  chooserLoading,
  chooserLocalRuntime,
  chooserOpen,
  chooserRefresh,
  chooserRuntimeLabel,
  chooserSubtitle,
  chooserSummaryLine,
  chooserTitle,
  chooserUnknownOwner
} from './ledger-chooser-copy'
import { useLedgerOwnerLabels } from './ledger-owner-labels'
import { pageOwnerLedgerTitle } from './ledger-page-copy'

export type LedgerChooserProps = {
  environmentId?: string
  onOpen: (ledger: LedgerSummary, environmentId: string | undefined, title: string) => void
}

/** Catalog navigation deliberately lists detached ledgers too; it never creates an empty ledger. */
export function LedgerChooser({ environmentId, onOpen }: LedgerChooserProps): React.JSX.Element {
  const [ledgers, setLedgers] = useState<LedgerSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(environmentId)
  const ledgerRequest = useAppStore((state) => state.ledgerRequest)
  const ownerLabels = useLedgerOwnerLabels(selectedEnvironmentId)
  const reloadOwnerLabels = ownerLabels.reload
  const load = useCallback(async () => {
    const requestGeneration = ++generation.current
    setLoading(true)
    setError(null)
    try {
      const response = await ledgerRequest({ operation: 'catalog' }, selectedEnvironmentId)
      if (requestGeneration === generation.current) {
        setLedgers(response.ledgers ?? [])
      }
    } catch (cause) {
      if (requestGeneration === generation.current) {
        setError(cause instanceof Error ? cause.message : 'Ledger catalog unavailable')
      }
    } finally {
      if (requestGeneration === generation.current) {
        setLoading(false)
      }
    }
  }, [ledgerRequest, selectedEnvironmentId])
  useEffect(() => {
    setSelectedEnvironmentId(environmentId)
  }, [environmentId])
  useEffect(() => {
    void load()
  }, [load])
  const runtimeOptions = runtimeEnvironments as PublicKnownRuntimeEnvironment[]
  return (
    <section className="flex h-full min-h-0 flex-col gap-4 overflow-auto scrollbar-sleek p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">{chooserTitle()}</h1>
          <p className="text-sm text-muted-foreground">{chooserSubtitle()}</p>
        </div>
        <div className="flex gap-2">
          <Select
            value={selectedEnvironmentId ?? 'local'}
            onValueChange={(value) =>
              setSelectedEnvironmentId(value === 'local' ? undefined : value)
            }
          >
            <SelectTrigger size="sm" aria-label={chooserRuntimeLabel()}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="local">{chooserLocalRuntime()}</SelectItem>
              {runtimeOptions.map((environment) => (
                <SelectItem key={environment.id} value={environment.id}>
                  {environment.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              reloadOwnerLabels()
              void load()
            }}
            disabled={loading}
          >
            <RefreshCw className="mr-2 size-4" />
            {chooserRefresh()}
          </Button>
        </div>
      </div>
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
        >
          {chooserCatalogError(error)}
        </div>
      ) : null}
      {loading ? <p className="text-sm text-muted-foreground">{chooserLoading()}</p> : null}
      {!loading && !error && !ledgers.length ? (
        <p className="rounded-md border p-6 text-center text-sm text-muted-foreground">
          {chooserEmpty()}
        </p>
      ) : null}
      <div className="grid gap-2">
        {ledgers.map((ledger) => {
          const ownerName =
            ownerLabels.lookup(ledger.owner) ??
            ownerLabels.lookup(ledger.formerOwner) ??
            ledger.owner?.id ??
            ledger.formerOwner?.id ??
            chooserUnknownOwner()
          return (
            <Card key={ledger.ledgerId} className="rounded-lg">
              <CardContent className="flex items-center gap-3 p-4">
                <div className="flex size-8 items-center justify-center rounded-md bg-muted">
                  {ledger.owner ? (
                    <FolderOpen className="size-4" />
                  ) : (
                    <Archive className="size-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{ownerName}</p>
                  <p className="text-xs text-muted-foreground">{chooserSummaryLine(ledger)}</p>
                </div>
                <Button
                  size="sm"
                  onClick={() =>
                    onOpen(ledger, selectedEnvironmentId, pageOwnerLedgerTitle(ownerName))
                  }
                >
                  {chooserOpen()}
                </Button>
              </CardContent>
            </Card>
          )
        })}
      </div>
    </section>
  )
}

export default LedgerChooser
