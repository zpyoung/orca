import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import { ObjectiveEnrollmentPayloadSchema } from '../../../shared/fork-heimdall-objective/contract-types'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'

export function HeimdallConcurrencyControl({
  enrollment,
  readOnly,
  busy,
  supported,
  updating,
  onChange
}: {
  enrollment: WatcherEnrollment
  readOnly: boolean
  busy: boolean
  supported: boolean
  updating: boolean
  onChange: (maxConcurrency: number) => void
}): React.JSX.Element | null {
  const parsed =
    enrollment.kind === 'objective'
      ? ObjectiveEnrollmentPayloadSchema.safeParse(enrollment.kindPayload)
      : null
  const contract = parsed?.success ? parsed.data : null
  const maxConcurrency = contract?.maxConcurrency ?? null
  const [draft, setDraft] = useState(maxConcurrency === null ? '' : String(maxConcurrency))

  useEffect(() => {
    if (!busy && maxConcurrency !== null) {
      setDraft(String(maxConcurrency))
    }
  }, [busy, maxConcurrency])

  if (!contract) {
    return null
  }
  const invalid = !/^[1-9]\d*$/u.test(draft) || Number(draft) > 1_024
  const fixed = contract.workspaceKind === 'folder'
  return (
    <form
      className="mt-3 flex max-w-sm items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        if (!invalid) {
          onChange(Number(draft))
        }
      }}
    >
      <div className="min-w-0 flex-1 space-y-1">
        <Label htmlFor="heimdall-max-concurrency" className="text-xs">
          {translate('fork.heimdall.controls.maxConcurrency', 'Max concurrency')}
        </Label>
        <Input
          id="heimdall-max-concurrency"
          type="number"
          min="1"
          max="1024"
          step="1"
          value={draft}
          disabled={readOnly || busy || !supported || fixed}
          className="h-8 text-xs tabular-nums"
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
      </div>
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={readOnly || busy || !supported || fixed || invalid}
      >
        {updating ? <Loader2 className="animate-spin" aria-hidden /> : null}
        {translate('fork.heimdall.controls.updateConcurrency', 'Update cap')}
      </Button>
    </form>
  )
}
