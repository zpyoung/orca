import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import {
  HANDOFF_TEMPLATE_BODY_MAX,
  HANDOFF_TEMPLATE_NAME_MAX,
  HANDOFF_TEMPLATES_MAX
} from '../../../../../shared/fork-session-handoff/handoff-template-normalization'
import type { ForkSessionHandoffTemplate } from '../../../../../shared/fork-session-handoff/handoff-settings-types'

const NO_TEMPLATE = '__none__'
const NEW_TEMPLATE = '__new__'

type HandoffNotesControlsProps = {
  disabled: boolean
  templates: ForkSessionHandoffTemplate[]
  selectedTemplateId: string | null
  steeringNote: string
  onTemplateChange: (templateId: string | null) => void
  onSteeringNoteChange: (value: string) => void
  onSaveSteeringNoteAsTemplate: (name: string) => Promise<boolean>
}

export function HandoffNotesControls({
  disabled,
  templates,
  selectedTemplateId,
  steeringNote,
  onTemplateChange,
  onSteeringNoteChange,
  onSaveSteeringNoteAsTemplate
}: HandoffNotesControlsProps): React.JSX.Element {
  const [namingTemplate, setNamingTemplate] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [saving, setSaving] = useState(false)
  const atTemplateLimit = templates.length >= HANDOFF_TEMPLATES_MAX
  const steeringNoteTooLong = steeringNote.trim().length > HANDOFF_TEMPLATE_BODY_MAX
  const canSave = Boolean(
    templateName.trim() &&
    steeringNote.trim() &&
    !steeringNoteTooLong &&
    !atTemplateLimit &&
    !saving
  )

  const cancelNaming = (): void => {
    setNamingTemplate(false)
    setTemplateName('')
  }

  const changeTemplate = (value: string): void => {
    if (value === NEW_TEMPLATE) {
      setNamingTemplate(true)
      setTemplateName('')
      return
    }
    cancelNaming()
    onTemplateChange(value === NO_TEMPLATE ? null : value)
  }

  const saveTemplate = async (): Promise<void> => {
    if (!canSave) {
      return
    }
    setSaving(true)
    try {
      if (await onSaveSteeringNoteAsTemplate(templateName.trim())) {
        cancelNaming()
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <fieldset disabled={disabled || saving} className="min-w-0 space-y-3 disabled:opacity-60">
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
          value={namingTemplate ? NEW_TEMPLATE : (selectedTemplateId ?? NO_TEMPLATE)}
          onValueChange={changeTemplate}
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
            <SelectItem
              value={NEW_TEMPLATE}
              title={
                atTemplateLimit
                  ? translate(
                      'components.agentSessionContinuation.forkSessionHandoff.templateLimitReached',
                      'The template limit has been reached.'
                    )
                  : undefined
              }
            >
              {translate(
                'components.agentSessionContinuation.forkSessionHandoff.newTemplate',
                'New Template'
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
          aria-describedby={steeringNoteTooLong ? 'handoff-template-note-limit' : undefined}
          placeholder={translate(
            'components.agentSessionContinuation.forkSessionHandoff.steeringNotePlaceholder',
            'What should the new Agent focus on?'
          )}
          onChange={(event) => onSteeringNoteChange(event.target.value)}
        />
        {steeringNoteTooLong ? (
          <p id="handoff-template-note-limit" className="text-[11px] text-destructive" role="alert">
            {translate(
              'components.agentSessionContinuation.forkSessionHandoff.templateBodyTooLong',
              'Shorten this note to {{limit}} characters before saving it as a template.',
              { limit: HANDOFF_TEMPLATE_BODY_MAX.toLocaleString() }
            )}
          </p>
        ) : null}
      </div>

      {namingTemplate ? (
        <div
          className="space-y-2 rounded-md border border-border/60 bg-muted/30 p-3"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              cancelNaming()
            }
          }}
        >
          <Label htmlFor="handoff-new-template-name" className="text-xs">
            {translate(
              'components.agentSessionContinuation.forkSessionHandoff.templateName',
              'Template name'
            )}
          </Label>
          <Input
            id="handoff-new-template-name"
            autoFocus
            value={templateName}
            maxLength={HANDOFF_TEMPLATE_NAME_MAX}
            placeholder={translate(
              'components.agentSessionContinuation.forkSessionHandoff.templateNamePlaceholder',
              'e.g. Continue implementation'
            )}
            onChange={(event) => setTemplateName(event.target.value)}
          />
          {atTemplateLimit ? (
            <p className="text-[11px] text-destructive" role="alert">
              {translate(
                'components.agentSessionContinuation.forkSessionHandoff.templateLimitReached',
                'The template limit has been reached.'
              )}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={cancelNaming}>
              {translate(
                'components.agentSessionContinuation.forkSessionHandoff.cancelTemplate',
                'Cancel'
              )}
            </Button>
            <Button type="button" size="sm" disabled={!canSave} onClick={() => void saveTemplate()}>
              {saving
                ? translate(
                    'components.agentSessionContinuation.forkSessionHandoff.savingTemplate',
                    'Saving…'
                  )
                : translate(
                    'components.agentSessionContinuation.forkSessionHandoff.saveTemplate',
                    'Save template'
                  )}
            </Button>
          </div>
        </div>
      ) : null}
    </fieldset>
  )
}
