import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  LedgerEntry,
  LedgerEntryType,
  LedgerLocation,
  LedgerLocationBase
} from '../../../../shared/ledger'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { Project } from '../../../../shared/project-types'
import { readLedgerCatalog, type LedgerCatalog } from '@/runtime/runtime-ledger-catalog-client'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { LedgerEntryFields } from './LedgerEntryFields'

const types: LedgerEntryType[] = ['bug', 'deferred', 'test-gap', 'proposal', 'decision']
const fields: Record<LedgerEntryType, string[]> = {
  bug: ['title', 'file', 'description', 'severity'],
  deferred: ['title', 'why_deferred', 'priority'],
  'test-gap': ['title', 'file_under_test', 'reason_skipped'],
  proposal: ['title', 'context', 'recommendation'],
  decision: ['title', 'context', 'decision', 'consequences', 'status']
}
const formKeys = new Set([
  'type',
  'locationPath',
  'locationLine',
  'locationBaseKey',
  'locationExternal',
  'locationHost'
])
type FormValue = Record<string, unknown>
type LocationOption = { key: string; label: string; base: LedgerLocationBase }

function locationFromEntry(entry: LedgerEntry | null): Partial<FormValue> {
  if (!entry) {
    return { type: 'bug' }
  }
  const key = entry.type === 'bug' ? 'file' : entry.type === 'test-gap' ? 'file_under_test' : null
  const location =
    key && entry.content[key] && typeof entry.content[key] === 'object'
      ? (entry.content[key] as LedgerLocation)
      : null
  if (!location) {
    return { type: entry.type, ...entry.content }
  }
  return {
    type: entry.type,
    ...entry.content,
    locationPath: location.path,
    locationLine: location.line === undefined ? '' : String(location.line),
    locationBaseKey: `existing:${entry.id}`,
    locationExternal: location.external === true,
    locationHost: location.host ?? location.base.host ?? '',
    __existingBase: location.base
  }
}

export type LedgerEntryFormProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  entry: LedgerEntry | null
  environmentId?: string
  onSubmit: (type: LedgerEntryType, content: Record<string, unknown>) => Promise<void>
}

export function LedgerEntryForm({
  open,
  onOpenChange,
  entry,
  environmentId,
  onSubmit
}: LedgerEntryFormProps): React.JSX.Element {
  const [form, setForm] = useState<FormValue>(() => locationFromEntry(entry))
  const [catalog, setCatalog] = useState<LedgerCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const initializedFor = useRef<string | null>(entry?.id ?? null)
  const generation = useRef(0)
  const runtimeTarget = useMemo<RuntimeClientTarget>(
    () => (environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }),
    [environmentId]
  )
  const type = (form.type as LedgerEntryType) || 'bug'
  const locationField = type === 'bug' ? 'file' : type === 'test-gap' ? 'file_under_test' : null
  useEffect(() => {
    if (!open) {
      initializedFor.current = null
      return
    }
    const sourceId = JSON.stringify([environmentId ?? null, entry?.id ?? null])
    if (initializedFor.current === sourceId) {
      return
    }
    initializedFor.current = sourceId
    setForm(locationFromEntry(entry))
    setError(null)
  }, [entry, open, environmentId])
  useEffect(() => {
    if (!open || !locationField) {
      return
    }
    const request = ++generation.current
    setCatalogError(null)
    setCatalog(null)
    void readLedgerCatalog(runtimeTarget)
      .then((result) => {
        if (request === generation.current) {
          setCatalog(result)
        }
      })
      .catch((cause: unknown) => {
        if (request === generation.current) {
          setCatalogError(cause instanceof Error ? cause.message : 'Runtime catalog unavailable')
        }
      })
    return () => {
      generation.current += 1
    }
  }, [locationField, open, runtimeTarget])
  const locationOptions = useMemo<LocationOption[]>(() => {
    const options: LocationOption[] = []
    catalog?.projects.forEach((project: Project) =>
      options.push({
        key: JSON.stringify(['project', project.id]),
        label: translate('ledger.form.projectBase', 'Project: {{name}}', {
          name: project.displayName
        }),
        base: { kind: 'project', id: project.id }
      })
    )
    catalog?.folderWorkspaces.forEach((workspace: FolderWorkspace) =>
      options.push({
        key: JSON.stringify(['workspace', workspace.id]),
        label: translate('ledger.form.workspaceBase', 'Workspace: {{name}}', {
          name: workspace.name
        }),
        base: { kind: 'workspace', id: workspace.id, host: workspace.connectionId ?? 'local' }
      })
    )
    const existing = form.__existingBase as LedgerLocationBase | undefined
    if (
      existing &&
      !options.some(
        (option) => option.base.kind === existing.kind && option.base.id === existing.id
      )
    ) {
      options.unshift({
        key: `existing:${entry?.id ?? 'entry'}`,
        label: translate('ledger.form.historicalBase', 'Historical {{kind}}: {{id}}', {
          kind: existing.kind,
          id: existing.id
        }),
        base: existing
      })
    }
    return options
  }, [catalog, entry?.id, form.__existingBase])
  const existingBaseKey = locationOptions.find((option) => {
    const base = form.__existingBase as LedgerLocationBase | undefined
    return base && option.base.kind === base.kind && option.base.id === base.id
  })?.key
  const currentBaseKey = String(form.locationBaseKey ?? '')
  const selectedBaseKey = currentBaseKey.startsWith('existing:')
    ? (existingBaseKey ?? currentBaseKey)
    : currentBaseKey
  const update = (key: string, value: unknown) =>
    setForm((current) => ({ ...current, [key]: value }))
  const submit = async () => {
    setError(null)
    const missing = fields[type].find((field) =>
      field === 'file' || field === 'file_under_test'
        ? !String(form.locationPath ?? '').trim() || !form.locationBaseKey
        : !String(form[field] ?? '').trim()
    )
    if (missing) {
      setError(`${missing} is required`)
      return
    }
    if (locationField && form.locationExternal && !String(form.locationHost ?? '').trim()) {
      setError('External host is required')
      return
    }
    if (
      locationField &&
      String(form.locationLine ?? '').trim() &&
      (!/^\d+$/.test(String(form.locationLine)) ||
        !Number.isSafeInteger(Number(form.locationLine)) ||
        Number(form.locationLine) < 1)
    ) {
      setError('Line must be a positive safe integer')
      return
    }
    const severity = type === 'bug' ? String(form.severity) : ''
    const priority = type === 'deferred' ? String(form.priority) : ''
    if (severity && !['critical', 'high', 'medium', 'low'].includes(severity)) {
      setError('Invalid severity')
      return
    }
    if (priority && !['high', 'medium', 'low'].includes(priority)) {
      setError('Invalid priority')
      return
    }
    if (
      type === 'decision' &&
      !['proposed', 'accepted', 'superseded'].includes(String(form.status))
    ) {
      setError('Invalid decision status')
      return
    }
    const content: FormValue = Object.fromEntries(
      Object.entries(form).filter(([key]) => !formKeys.has(key) && key !== '__existingBase')
    )
    if (locationField) {
      const option = locationOptions.find((candidate) => candidate.key === form.locationBaseKey)
      const base = option?.base ?? (form.__existingBase as LedgerLocationBase | undefined)
      if (!base) {
        setError('Location base is required')
        return
      }
      const line = String(form.locationLine ?? '').trim()
      const original = entry?.content[locationField]
      const location = {
        ...(original && typeof original === 'object' ? original : {}),
        path: String(form.locationPath).trim(),
        base
      } as LedgerLocation
      if (line) {
        location.line = Number(line)
      } else {
        delete location.line
      }
      location.external = Boolean(form.locationExternal)
      if (location.external) {
        location.host = String(form.locationHost).trim()
      } else if (
        original &&
        typeof original === 'object' &&
        'external' in original &&
        original.external
      ) {
        delete location.host
      }
      content[locationField] = location
    }
    setPending(true)
    try {
      await onSubmit(type, content)
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to save ledger entry')
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) {
          onOpenChange(next)
        }
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto scrollbar-sleek sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {entry
              ? translate('ledger.form.editTitle', 'Edit {{id}}', { id: entry.id })
              : translate('ledger.form.newTitle', 'New ledger entry')}
          </DialogTitle>
        </DialogHeader>
        {entry ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'ledger.form.sourceRevision',
              'Source revision: {{revision}}. Save will be checked against this revision.',
              { revision: entry.revision }
            )}
          </p>
        ) : null}
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="ledger-entry-type">{translate('ledger.panel.typeLabel', 'Type')}</Label>
            <Select
              disabled={Boolean(entry) || pending}
              value={type}
              onValueChange={(value) => {
                const next = value as LedgerEntryType
                // Why: fields that don't exist on the new type would still be submitted as content,
                // but wiping the whole draft also throws away the shared title the user just typed.
                setForm((current) => ({
                  ...Object.fromEntries(
                    Object.entries(current).filter(
                      ([key]) => fields[next].includes(key) || formKeys.has(key)
                    )
                  ),
                  type: next
                }))
              }}
            >
              <SelectTrigger id="ledger-entry-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {types.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <LedgerEntryFields
            type={type}
            form={form}
            pending={pending}
            catalogError={catalogError}
            locationOptions={locationOptions}
            selectedBaseKey={selectedBaseKey}
            onUpdate={update}
          />
          {error ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button disabled={pending} variant="outline" onClick={() => onOpenChange(false)}>
              {translate('ledger.form.cancel', 'Cancel')}
            </Button>
            <Button disabled={pending || Boolean(catalogError)} onClick={() => void submit()}>
              {pending
                ? translate('ledger.form.saving', 'Saving…')
                : entry
                  ? translate('ledger.form.save', 'Save')
                  : translate('ledger.form.create', 'Create')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export default LedgerEntryForm
