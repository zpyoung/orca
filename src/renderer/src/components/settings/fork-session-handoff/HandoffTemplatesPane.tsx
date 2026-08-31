import { useMemo, useState } from 'react'
import { Plus, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  getDefaultHandoffTemplates,
  getHandoffTemplates
} from '@/lib/fork-session-handoff/handoff-template-catalog'
import {
  createTemplateDraft,
  persistHandoffTemplateMutation
} from '@/lib/fork-session-handoff/handoff-template-mutations'
import { useAppStore } from '@/store'
import { HANDOFF_TEMPLATES_MAX } from '../../../../../shared/fork-session-handoff/handoff-template-normalization'
import type {
  ForkSessionHandoffTemplate,
  ForkSessionHandoffTemplateMutation
} from '../../../../../shared/fork-session-handoff/handoff-settings-types'
import { HandoffTemplateEditorDialog } from './HandoffTemplateEditorDialog'
import { HandoffTemplateRow } from './HandoffTemplateRow'

type EditorState = {
  mode: 'add' | 'edit'
  template: ForkSessionHandoffTemplate
} | null

async function persistTemplateMutation(
  mutation: ForkSessionHandoffTemplateMutation
): Promise<boolean> {
  try {
    await persistHandoffTemplateMutation({
      update: (updates) => useAppStore.getState().updateSettingsOrThrow(updates),
      mutation
    })
    return true
  } catch (error) {
    toast.error(
      translate('components.settings.forkSessionHandoff.saveFailed', 'Could not save templates'),
      { description: error instanceof Error ? error.message : String(error) }
    )
    return false
  }
}

/** Manages the editable list of reusable session-handoff templates. */
export function HandoffTemplatesPane(): React.JSX.Element {
  const configuredTemplates = useAppStore((state) => state.settings?.forkSessionHandoff?.templates)
  // Why: the built-in catalog is rebuilt per call, so an unmemoized list would hand the
  // editor dialog a fresh template array on every keystroke.
  const templates = useMemo(() => getHandoffTemplates(configuredTemplates), [configuredTemplates])
  const confirm = useConfirmationDialog()
  const [editor, setEditor] = useState<EditorState>(null)
  const atLimit = templates.length >= HANDOFF_TEMPLATES_MAX

  const saveEditor = async (
    values: Pick<ForkSessionHandoffTemplate, 'name' | 'body'>
  ): Promise<boolean> => {
    if (!editor) {
      return false
    }
    const mutation: ForkSessionHandoffTemplateMutation =
      editor.mode === 'add'
        ? {
            type: 'add',
            template: { ...editor.template, ...values },
            seedTemplates: getDefaultHandoffTemplates()
          }
        : {
            type: 'update',
            id: editor.template.id,
            patch: values,
            seedTemplates: getDefaultHandoffTemplates()
          }
    if (!(await persistTemplateMutation(mutation))) {
      return false
    }
    const saved = useAppStore
      .getState()
      .settings?.forkSessionHandoff?.templates?.find(
        (template) => template.id === editor.template.id
      )
    return saved?.name === values.name.trim() && saved.body === values.body.trim()
  }

  const remove = async (template: ForkSessionHandoffTemplate): Promise<void> => {
    const confirmed = await confirm({
      title: translate('components.settings.forkSessionHandoff.deleteTitle', 'Delete “{{name}}”?', {
        name: template.name
      }),
      description: translate(
        'components.settings.forkSessionHandoff.deleteDescription',
        'This template will no longer be available in the handoff dialog.'
      ),
      confirmLabel: translate('components.settings.forkSessionHandoff.delete', 'Delete'),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    await persistTemplateMutation({
      type: 'remove',
      id: template.id,
      seedTemplates: getDefaultHandoffTemplates()
    })
  }

  const reset = async (): Promise<void> => {
    const confirmed = await confirm({
      title: translate(
        'components.settings.forkSessionHandoff.resetTitle',
        'Reset handoff templates?'
      ),
      description: translate(
        'components.settings.forkSessionHandoff.resetDescription',
        'Custom templates and edits will be removed. The latest built-in defaults will return.'
      ),
      confirmLabel: translate(
        'components.settings.forkSessionHandoff.resetConfirm',
        'Reset to defaults'
      ),
      confirmVariant: 'destructive'
    })
    if (confirmed) {
      await persistTemplateMutation({ type: 'reset' })
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            {translate('components.settings.forkSessionHandoff.templates', 'Templates')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'components.settings.forkSessionHandoff.templatesDescription',
              'Add a saved instruction block to any new-session handoff brief.'
            )}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={atLimit}
          title={
            atLimit
              ? translate(
                  'components.settings.forkSessionHandoff.limitReached',
                  'The template limit has been reached.'
                )
              : undefined
          }
          onClick={() => setEditor({ mode: 'add', template: createTemplateDraft('', '') })}
        >
          <Plus />
          {translate('components.settings.forkSessionHandoff.add', 'Add template')}
        </Button>
      </div>

      <div className="-mx-2 divide-y divide-border/50">
        {templates.map((template) => (
          <HandoffTemplateRow
            key={template.id}
            template={template}
            onEdit={(selected) => setEditor({ mode: 'edit', template: selected })}
            onRemove={(selected) => void remove(selected)}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
        <span className="text-[11px] text-muted-foreground">
          {translate(
            'components.settings.forkSessionHandoff.count',
            '{{count}} of {{limit}} templates',
            { count: templates.length, limit: HANDOFF_TEMPLATES_MAX }
          )}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={configuredTemplates === undefined}
          onClick={() => void reset()}
        >
          <RotateCcw />
          {translate('components.settings.forkSessionHandoff.reset', 'Reset to defaults')}
        </Button>
      </div>

      {editor ? (
        <HandoffTemplateEditorDialog
          key={`${editor.mode}:${editor.template.id}`}
          open
          mode={editor.mode}
          template={editor.template}
          templates={templates}
          onOpenChange={(open) => !open && setEditor(null)}
          onSave={saveEditor}
        />
      ) : null}
    </div>
  )
}
