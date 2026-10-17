import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { LoopSessionPolicySchema } from '../../../shared/fork-loops/loop-types'
import { isFolderRepo } from '../../../shared/repo-kind'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  SelectField,
  TextField,
  wholeNumberError,
  type SectionProps
} from './LoopSetupAdvancedFields'

export const DEFAULT_ID_PREFIX = 'loop-setup'

/** Folder workspaces have no git history to checkpoint into. */
export function useIsFolderWorkspace(worktreeId: string): boolean {
  return useAppStore((s) =>
    s.repos.some((repo) => repo.id === getRepoIdFromWorktreeId(worktreeId) && isFolderRepo(repo))
  )
}

export function PromptField({
  draft,
  errors,
  update,
  idPrefix = DEFAULT_ID_PREFIX,
  errorMessage
}: SectionProps & { idPrefix?: string; errorMessage: string }): React.JSX.Element {
  return (
    <TextField
      id={`${idPrefix}-prompt`}
      rows={4}
      label={translate('fork.loops.setup.prompt', 'Prompt')}
      placeholder={translate(
        'fork.loops.setup.promptPlaceholder',
        'What should the agent do on every iteration?'
      )}
      value={draft.prompt}
      error={errors.has('prompt') ? errorMessage : undefined}
      onChange={(prompt) => update({ prompt })}
    />
  )
}

export function IntervalFields({
  draft,
  errors,
  update,
  idPrefix = DEFAULT_ID_PREFIX
}: SectionProps & { idPrefix?: string }): React.JSX.Element {
  return (
    <div className="grid grid-cols-2 gap-3">
      <TextField
        inputMode="numeric"
        id={`${idPrefix}-interval`}
        label={translate('fork.loops.setup.intervalMinutes', 'Run every (minutes)')}
        value={draft.intervalMinutes}
        error={errors.has('interval') ? wholeNumberError() : undefined}
        onChange={(intervalMinutes) => update({ intervalMinutes })}
      />
      <SelectField
        label={translate('fork.loops.setup.intervalAnchor', 'Counted from')}
        value={draft.anchor}
        options={[
          {
            value: 'from-end',
            label: translate('fork.loops.setup.anchorFromEnd', 'End of the last iteration')
          },
          {
            value: 'wall-clock',
            label: translate('fork.loops.setup.anchorWallClock', 'The clock')
          }
        ]}
        onChange={(value) => update({ anchor: value === 'wall-clock' ? 'wall-clock' : 'from-end' })}
      />
    </div>
  )
}

export function SessionPolicyField({ draft, update }: SectionProps): React.JSX.Element {
  return (
    <SelectField
      label={translate('fork.loops.setup.session', 'Session')}
      value={draft.sessionPolicy}
      options={[
        {
          value: 'fresh',
          label: translate('fork.loops.setup.sessionFresh', 'Fresh session each iteration')
        },
        {
          value: 'continue',
          label: translate('fork.loops.setup.sessionContinue', 'Continue the same session')
        }
      ]}
      onChange={(value) => {
        const policy = LoopSessionPolicySchema.safeParse(value)
        if (policy.success) {
          update({ sessionPolicy: policy.data })
        }
      }}
    />
  )
}

export function MaxIterationsField({
  draft,
  errors,
  update,
  idPrefix = DEFAULT_ID_PREFIX
}: SectionProps & { idPrefix?: string }): React.JSX.Element {
  return (
    <TextField
      inputMode="numeric"
      id={`${idPrefix}-max-iterations`}
      label={translate('fork.loops.setup.maxIterations', 'Maximum iterations')}
      hint={translate('fork.loops.setup.maxIterationsHint', 'Clear to run with no limit.')}
      value={draft.maxIterations}
      error={errors.has('iterations') ? wholeNumberError() : undefined}
      onChange={(maxIterations) => update({ maxIterations })}
    />
  )
}
