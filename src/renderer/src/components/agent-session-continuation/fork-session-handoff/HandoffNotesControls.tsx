import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import type { ForkSessionHandoffTemplate } from '../../../../../shared/fork-session-handoff/handoff-settings-types'

const NO_TEMPLATE = '__none__'

type HandoffNotesControlsProps = {
  disabled: boolean
  templates: ForkSessionHandoffTemplate[]
  selectedTemplateId: string | null
  steeringNote: string
  onTemplateChange: (templateId: string | null) => void
  onSteeringNoteChange: (value: string) => void
}

export function HandoffNotesControls({
  disabled,
  templates,
  selectedTemplateId,
  steeringNote,
  onTemplateChange,
  onSteeringNoteChange
}: HandoffNotesControlsProps): React.JSX.Element {
  return (
    <fieldset disabled={disabled} className="min-w-0 space-y-3 disabled:opacity-60">
      <legend className="mb-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {translate('components.agentSessionContinuation.forkSessionHandoff.notes', 'Notes')}
      </legend>

      <div className="space-y-1.5">
        <Label htmlFor="handoff-template" className="text-xs">
          {translate(
            'components.agentSessionContinuation.forkSessionHandoff.template',
            'Reusable template'
          )}
        </Label>
        <Select
          value={selectedTemplateId ?? NO_TEMPLATE}
          onValueChange={(value) => onTemplateChange(value === NO_TEMPLATE ? null : value)}
        >
          <SelectTrigger id="handoff-template" size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_TEMPLATE}>
              {translate(
                'components.agentSessionContinuation.forkSessionHandoff.noTemplate',
                'No template'
              )}
            </SelectItem>
            {templates.map((template) => (
              <SelectItem key={template.id} value={template.id}>
                {template.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="handoff-steering-note" className="text-xs">
          {translate(
            'components.agentSessionContinuation.forkSessionHandoff.steeringNote',
            'Steering note'
          )}
        </Label>
        <Textarea
          id="handoff-steering-note"
          value={steeringNote}
          rows={4}
          className="resize-y text-xs"
          placeholder={translate(
            'components.agentSessionContinuation.forkSessionHandoff.steeringNotePlaceholder',
            'What should the new Agent focus on?'
          )}
          onChange={(event) => onSteeringNoteChange(event.target.value)}
        />
      </div>
    </fieldset>
  )
}
