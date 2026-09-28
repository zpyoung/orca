import { useId } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { translate } from '@/i18n/i18n'
import {
  ObjectiveEnrollmentFieldHelp,
  objectiveConcurrencyHelp
} from './ObjectiveEnrollmentFieldHelp'
import type { ObjectiveEnrollmentDraft } from './objective-enrollment-model'

export function ObjectiveEnrollmentParallelFields({
  draft,
  disabled,
  parallelUnsupported,
  onDraftChange
}: {
  draft: ObjectiveEnrollmentDraft
  disabled: boolean
  parallelUnsupported: boolean
  onDraftChange: (draft: ObjectiveEnrollmentDraft) => void
}): React.JSX.Element {
  const concurrencyId = useId()
  const lanesId = useId()
  const concurrencyFixed = draft.workspaceKind === 'folder' || parallelUnsupported

  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)_148px] items-center gap-3">
        <div className="space-y-0.5">
          <div className="flex items-center gap-1">
            <Label htmlFor={concurrencyId}>
              {translate('fork.heimdallObjective.enrollment.maxConcurrency', 'Max concurrency')}
            </Label>
            <ObjectiveEnrollmentFieldHelp {...objectiveConcurrencyHelp()} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            {draft.workspaceKind === 'folder'
              ? translate(
                  'fork.heimdallObjective.enrollment.folderConcurrencyHelp',
                  'Folder workspaces cannot create worktrees, so concurrency is limited to 1.'
                )
              : parallelUnsupported
                ? translate(
                    'fork.heimdallObjective.enrollment.hostConcurrencyHelp',
                    'This host does not support parallel execution yet; the watcher will run in place.'
                  )
                : translate(
                    'fork.heimdallObjective.enrollment.maxConcurrencyDescription',
                    'Workers may use up to this many isolated dispatch slots.'
                  )}
          </p>
        </div>
        <div className="tabular-nums">
          <Input
            id={concurrencyId}
            type="number"
            min="1"
            max="1024"
            step="1"
            value={
              concurrencyFixed
                ? 1
                : Number.isFinite(draft.maxConcurrency)
                  ? draft.maxConcurrency
                  : ''
            }
            disabled={disabled || concurrencyFixed}
            onChange={(event) =>
              onDraftChange({ ...draft, maxConcurrency: event.currentTarget.valueAsNumber })
            }
          />
        </div>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_148px] items-center gap-3">
        <div className="space-y-0.5">
          <Label htmlFor={lanesId}>
            {translate('fork.heimdallObjective.enrollment.lanes', 'Keep dependent work in lanes')}
          </Label>
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'fork.heimdallObjective.enrollment.lanesHelp',
              'Reuse one worker session for one-to-one task chains.'
            )}
          </p>
        </div>
        <div className="flex justify-end">
          <Switch
            id={lanesId}
            checked={parallelUnsupported ? false : draft.lanesEnabled}
            disabled={disabled || parallelUnsupported}
            onCheckedChange={(lanesEnabled) => onDraftChange({ ...draft, lanesEnabled })}
          />
        </div>
      </div>
    </>
  )
}
