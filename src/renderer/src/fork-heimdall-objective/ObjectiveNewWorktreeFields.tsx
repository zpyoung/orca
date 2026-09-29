import { useId } from 'react'
import { CreateFromPicker } from '@/components/repo/CreateFromPicker'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import { useRepoMap, useWorktreesForRepo } from '@/store/selectors'
import {
  effectiveNewWorktreeName,
  type ObjectiveEnrollmentDraft
} from './objective-enrollment-model'

type ObjectiveNewWorktreeFieldsProps = {
  repoId: string
  draft: ObjectiveEnrollmentDraft
  disabled: boolean
  onDraftChange: (draft: ObjectiveEnrollmentDraft) => void
}

/** Collects a name and optional base ref without changing the repository default. */
export function ObjectiveNewWorktreeFields({
  repoId,
  draft,
  disabled,
  onDraftChange
}: ObjectiveNewWorktreeFieldsProps): React.JSX.Element {
  const nameId = useId()
  const repoMap = useRepoMap()
  const worktrees = useWorktreesForRepo(repoId)

  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <Label htmlFor={nameId}>
          {translate('fork.heimdallObjective.enrollment.newWorktreeName', 'New worktree name')}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'fork.heimdallObjective.enrollment.newWorktreeNameHelp',
            'Suggested from the objective. Edit it to choose another name.'
          )}
        </p>
      </div>
      <Input
        id={nameId}
        value={effectiveNewWorktreeName(draft)}
        disabled={disabled}
        aria-invalid={draft.newWorktreeNameEdited && !draft.newWorktreeName.trim()}
        onChange={(event) =>
          onDraftChange({
            ...draft,
            newWorktreeName: event.currentTarget.value,
            newWorktreeNameEdited: true
          })
        }
      />
      <div className="space-y-2">
        <Label>
          {translate('fork.heimdallObjective.enrollment.newWorktreeBase', 'Base branch')}
        </Label>
        <CreateFromPicker
          key={repoId}
          repoId={repoId}
          repoMap={repoMap}
          worktrees={worktrees}
          value={draft.newWorktreeBaseBranch ?? ''}
          compact
          readOnly={disabled}
          onValueChange={(value) =>
            onDraftChange({ ...draft, newWorktreeBaseBranch: value || undefined })
          }
        />
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'fork.heimdallObjective.enrollment.newWorktreeBaseHelp',
            'Project default is used unless you choose another branch.'
          )}
        </p>
      </div>
    </section>
  )
}
