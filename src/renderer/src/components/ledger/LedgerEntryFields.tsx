import type { LedgerEntryType } from '../../../../shared/ledger'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'

type FormValue = Record<string, unknown>
type LocationOption = {
  key: string
  label: string
  base: { kind: string; id: string; host?: string }
}

const fields: Record<LedgerEntryType, string[]> = {
  bug: ['title', 'file', 'description', 'severity'],
  deferred: ['title', 'why_deferred', 'priority'],
  'test-gap': ['title', 'file_under_test', 'reason_skipped'],
  proposal: ['title', 'context', 'recommendation'],
  decision: ['title', 'context', 'decision', 'consequences', 'status']
}
const longFields = new Set([
  'description',
  'why_deferred',
  'reason_skipped',
  'context',
  'recommendation',
  'decision',
  'consequences'
])

type LedgerEntryFieldsProps = {
  type: LedgerEntryType
  form: FormValue
  pending: boolean
  catalogError: string | null
  locationOptions: LocationOption[]
  selectedBaseKey: string | undefined
  onUpdate: (key: string, value: unknown) => void
}

export function LedgerEntryFields({
  type,
  form,
  pending,
  catalogError,
  locationOptions,
  selectedBaseKey,
  onUpdate
}: LedgerEntryFieldsProps): React.JSX.Element {
  return (
    <>
      {fields[type].map((field) =>
        field === 'file' || field === 'file_under_test' ? (
          <div className="grid gap-3 rounded-md border p-3" key={field}>
            <Label>{field}</Label>
            <Input
              disabled={pending}
              placeholder={translate('ledger.fields.pathPlaceholder', 'Repository-relative path')}
              value={String(form.locationPath ?? '')}
              onChange={(event) => onUpdate('locationPath', event.target.value)}
            />
            <Input
              disabled={pending}
              type="number"
              min={1}
              step={1}
              placeholder={translate('ledger.fields.linePlaceholder', 'Line (optional)')}
              value={String(form.locationLine ?? '')}
              onChange={(event) => onUpdate('locationLine', event.target.value)}
            />
            <Select
              disabled={pending || Boolean(catalogError)}
              value={selectedBaseKey}
              onValueChange={(value) => onUpdate('locationBaseKey', value)}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={translate(
                    'ledger.fields.locationBasePlaceholder',
                    'Location base (required)'
                  )}
                />
              </SelectTrigger>
              <SelectContent>
                {locationOptions.map((option) => (
                  <SelectItem key={option.key} value={option.key}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <label className="flex items-center gap-2 text-sm">
              <input
                disabled={pending}
                type="checkbox"
                checked={Boolean(form.locationExternal)}
                onChange={(event) => onUpdate('locationExternal', event.target.checked)}
              />
              {translate('ledger.fields.externalLocation', 'External location')}
            </label>
            {form.locationExternal ? (
              <Input
                disabled={pending}
                placeholder={translate(
                  'ledger.fields.externalHostPlaceholder',
                  'External host (required)'
                )}
                value={String(form.locationHost ?? '')}
                onChange={(event) => onUpdate('locationHost', event.target.value)}
              />
            ) : null}
            {catalogError ? (
              <p role="alert" className="text-xs text-destructive">
                {catalogError}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="grid gap-2" key={field}>
            <Label htmlFor={`ledger-${field}`}>{field}</Label>
            {longFields.has(field) ? (
              <textarea
                id={`ledger-${field}`}
                disabled={pending}
                className="min-h-24 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                value={String(form[field] ?? '')}
                onChange={(event) => onUpdate(field, event.target.value)}
              />
            ) : ['severity', 'priority', 'status'].includes(field) ? (
              <Select
                disabled={pending}
                value={String(form[field] ?? '')}
                onValueChange={(value) => onUpdate(field, value)}
              >
                <SelectTrigger id={`ledger-${field}`}>
                  <SelectValue
                    placeholder={translate('ledger.fields.selectPlaceholder', 'Select {{field}}', {
                      field
                    })}
                  />
                </SelectTrigger>
                <SelectContent>
                  {(field === 'severity'
                    ? ['critical', 'high', 'medium', 'low']
                    : field === 'priority'
                      ? ['high', 'medium', 'low']
                      : ['proposed', 'accepted', 'superseded']
                  ).map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={`ledger-${field}`}
                disabled={pending}
                value={String(form[field] ?? '')}
                onChange={(event) => onUpdate(field, event.target.value)}
              />
            )}
          </div>
        )
      )}
    </>
  )
}
