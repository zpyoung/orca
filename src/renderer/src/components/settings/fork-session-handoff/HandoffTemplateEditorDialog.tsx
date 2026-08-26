import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  HANDOFF_TEMPLATE_BODY_MAX,
  HANDOFF_TEMPLATE_NAME_MAX
} from '../../../../../shared/fork-session-handoff/handoff-template-normalization'
import type { ForkSessionHandoffTemplate } from '../../../../../shared/fork-session-handoff/handoff-settings-types'

type HandoffTemplateEditorDialogProps = {
  open: boolean
  mode: 'add' | 'edit'
  template: ForkSessionHandoffTemplate
  templates: ForkSessionHandoffTemplate[]
  onOpenChange: (open: boolean) => void
  onSave: (values: Pick<ForkSessionHandoffTemplate, 'name' | 'body'>) => Promise<boolean>
}

/** Edits the user-facing name and reusable instruction body for one template. */
export function HandoffTemplateEditorDialog({
  open,
  mode,
  template,
  templates,
  onOpenChange,
  onSave
}: HandoffTemplateEditorDialogProps): React.JSX.Element {
  const [name, setName] = useState(template.name)
  const [body, setBody] = useState(template.body)
  const [saving, setSaving] = useState(false)

  const trimmedName = name.trim()
  const trimmedBody = body.trim()
  const bodyTooLong = body.length > HANDOFF_TEMPLATE_BODY_MAX
  const duplicateName = templates.some(
    (candidate) =>
      candidate.id !== template.id &&
      candidate.name.trim().toLocaleLowerCase() === trimmedName.toLocaleLowerCase()
  )
  const canSave = Boolean(trimmedName && trimmedBody && !bodyTooLong && !saving)

  const save = async (): Promise<void> => {
    if (!canSave) {
      return
    }
    setSaving(true)
    try {
      const saved = await onSave({ name: trimmedName, body: trimmedBody })
      if (saved) {
        onOpenChange(false)
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !saving && onOpenChange(nextOpen)}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[min(90vh,44rem)] w-full max-w-2xl flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <DialogHeader className="px-6 pt-6 pb-0">
            <DialogTitle className="text-sm">
              {mode === 'edit'
                ? translate('components.settings.forkSessionHandoff.editTitle', 'Edit template')
                : translate('components.settings.forkSessionHandoff.addTitle', 'Add template')}
            </DialogTitle>
            <DialogDescription className="text-xs">
              {translate(
                'components.settings.forkSessionHandoff.editorDescription',
                'Add reusable instructions to the brief for a new Agent session.'
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="scrollbar-sleek min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
            <div className="space-y-2">
              <Label htmlFor="handoff-template-name">
                {translate('components.settings.forkSessionHandoff.name', 'Name')}
              </Label>
              <Input
                id="handoff-template-name"
                autoFocus
                value={name}
                disabled={saving}
                maxLength={HANDOFF_TEMPLATE_NAME_MAX}
                onChange={(event) => setName(event.target.value)}
              />
              {duplicateName ? (
                <p className="text-[11px] text-muted-foreground" role="status">
                  {translate(
                    'components.settings.forkSessionHandoff.duplicateName',
                    'Another template uses this name. Both templates will remain available.'
                  )}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="handoff-template-body">
                  {translate('components.settings.forkSessionHandoff.body', 'Instructions')}
                </Label>
                <span
                  id="handoff-template-body-count"
                  aria-live="polite"
                  className={cn(
                    'text-[11px] text-muted-foreground',
                    bodyTooLong && 'text-destructive'
                  )}
                >
                  {body.length.toLocaleString()} / {HANDOFF_TEMPLATE_BODY_MAX.toLocaleString()}
                </span>
              </div>
              <Textarea
                id="handoff-template-body"
                value={body}
                disabled={saving}
                rows={12}
                className="min-h-56 resize-y font-mono text-xs"
                aria-invalid={bodyTooLong || undefined}
                aria-describedby="handoff-template-body-count handoff-template-variables"
                onChange={(event) => setBody(event.target.value)}
              />
              <p id="handoff-template-variables" className="text-[11px] text-muted-foreground">
                {translate(
                  'components.settings.forkSessionHandoff.variables',
                  'Variables: {{gitStatus}}, {{changedPaths}}, and {{openEditorTabs}}. SCREAMING_CASE aliases also work.',
                  {
                    gitStatus: '{{gitStatus}}',
                    changedPaths: '{{changedPaths}}',
                    openEditorTabs: '{{openEditorTabs}}'
                  }
                )}
              </p>
            </div>
          </div>

          <DialogFooter className="border-t border-border px-6 py-4">
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {translate('components.settings.forkSessionHandoff.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving
                ? translate('components.settings.forkSessionHandoff.saving', 'Saving…')
                : translate('components.settings.forkSessionHandoff.save', 'Save template')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
