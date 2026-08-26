import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import type { AgentSessionContinuationContextMode } from '@/lib/agent-session-continuation'
import type { ForkSessionHandoffIncludeToggles } from '../../../../../shared/fork-session-handoff/handoff-settings-types'

type HandoffContentControlsProps = {
  disabled: boolean
  contextMode: AgentSessionContinuationContextMode
  onContextModeChange: (mode: AgentSessionContinuationContextMode) => void
  contextControlDisabled: boolean
  contextDisabledReason: string | null
  includeToggles: ForkSessionHandoffIncludeToggles
  onIncludeTogglesChange: (toggles: ForkSessionHandoffIncludeToggles) => void
  repoStateLoading: boolean
}

export function HandoffContentControls({
  disabled,
  contextMode,
  onContextModeChange,
  contextControlDisabled,
  contextDisabledReason,
  includeToggles,
  onIncludeTogglesChange,
  repoStateLoading
}: HandoffContentControlsProps): React.JSX.Element {
  const setToggle = (key: keyof ForkSessionHandoffIncludeToggles, checked: boolean): void =>
    onIncludeTogglesChange({ ...includeToggles, [key]: checked })

  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3 disabled:opacity-60">
      <legend className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {translate('components.agentSessionContinuation.forkSessionHandoff.content', 'Content')}
      </legend>

      <div className="space-y-1.5">
        <Label htmlFor="handoff-context-mode" className="text-xs">
          {translate(
            'components.agentSessionContinuation.forkSessionHandoff.contextMode',
            'Session context'
          )}
        </Label>
        <Select
          value={contextMode}
          disabled={contextControlDisabled}
          onValueChange={(value) =>
            onContextModeChange(value as AgentSessionContinuationContextMode)
          }
        >
          <SelectTrigger id="handoff-context-mode" size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="focused">
              {translate(
                'components.agentSessionContinuation.forkSessionHandoff.focusedContext',
                'Focused handoff (Recommended)'
              )}
            </SelectItem>
            <SelectItem value="full">
              {translate(
                'components.agentSessionContinuation.forkSessionHandoff.fullContext',
                'Full session transcript'
              )}
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[11px] leading-4 text-muted-foreground">
          {contextDisabledReason ??
            (contextMode === 'focused'
              ? translate(
                  'components.agentSessionContinuation.forkSessionHandoff.focusedContextDescription',
                  'Carries status hints and reads older transcript details only when needed.'
                )
              : translate(
                  'components.agentSessionContinuation.forkSessionHandoff.fullContextDescription',
                  'Asks the new Agent to read the complete saved transcript.'
                ))}
        </p>
      </div>

      <div
        className="space-y-2"
        role="group"
        aria-label={translate(
          'components.agentSessionContinuation.forkSessionHandoff.includeContent',
          'Include in brief'
        )}
      >
        <ToggleRow
          id="handoff-include-repo-state"
          checked={includeToggles.repoState}
          label={translate(
            'components.agentSessionContinuation.forkSessionHandoff.repoState',
            'Git status and changed file paths'
          )}
          onChange={(checked) => setToggle('repoState', checked)}
        />
        <ToggleRow
          id="handoff-include-diffs"
          checked={includeToggles.diffBodies}
          disabled={!includeToggles.repoState}
          label={translate(
            'components.agentSessionContinuation.forkSessionHandoff.diffBodies',
            'Diff bodies'
          )}
          detail={translate(
            'components.agentSessionContinuation.forkSessionHandoff.diffBodiesDetail',
            'Opt-in and capped at 12,000 characters.'
          )}
          onChange={(checked) => setToggle('diffBodies', checked)}
        />
        <ToggleRow
          id="handoff-include-editor-tabs"
          checked={includeToggles.openEditorTabs}
          label={translate(
            'components.agentSessionContinuation.forkSessionHandoff.openEditorTabs',
            'Open editor tabs'
          )}
          onChange={(checked) => setToggle('openEditorTabs', checked)}
        />
      </div>

      {repoStateLoading ? (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'components.agentSessionContinuation.forkSessionHandoff.loadingRepoState',
            'Refreshing repository state…'
          )}
        </p>
      ) : null}
    </fieldset>
  )
}

function ToggleRow({
  id,
  checked,
  disabled = false,
  label,
  detail,
  onChange
}: {
  id: string
  checked: boolean
  disabled?: boolean
  label: string
  detail?: string
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
      <div className="min-w-0">
        <Label htmlFor={id} className="text-xs font-normal">
          {label}
        </Label>
        {detail ? <p className="text-[11px] text-muted-foreground">{detail}</p> : null}
      </div>
    </div>
  )
}
