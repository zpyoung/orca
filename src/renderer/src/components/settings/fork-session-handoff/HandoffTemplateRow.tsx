import { Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { ForkSessionHandoffTemplate } from '../../../../../shared/fork-session-handoff/handoff-settings-types'

type HandoffTemplateRowProps = {
  template: ForkSessionHandoffTemplate
  onEdit: (template: ForkSessionHandoffTemplate) => void
  onRemove: (template: ForkSessionHandoffTemplate) => void
}

/** Renders one editable template in the session-handoff settings list. */
export function HandoffTemplateRow({
  template,
  onEdit,
  onRemove
}: HandoffTemplateRowProps): React.JSX.Element {
  const editLabel = translate(
    'components.settings.forkSessionHandoff.editTemplate',
    'Edit {{name}}',
    {
      name: template.name
    }
  )
  const removeLabel = translate(
    'components.settings.forkSessionHandoff.removeTemplate',
    'Remove {{name}}',
    { name: template.name }
  )

  return (
    <div className="group/handoff-template flex items-center gap-3 rounded-md px-2 py-2.5 transition-colors hover:bg-accent/60 focus-within:bg-accent/60">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{template.name}</div>
        <div className="mt-0.5 truncate text-xs text-muted-foreground">
          {template.body.replace(/\s+/g, ' ')}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-0.5 transition-opacity can-hover:opacity-0 group-hover/handoff-template:opacity-100 group-focus-within/handoff-template:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={editLabel}
              onClick={() => onEdit(template)}
            >
              <Pencil />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {editLabel}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={removeLabel}
              className="text-muted-foreground hover:text-destructive"
              onClick={() => onRemove(template)}
            >
              <Trash2 />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {removeLabel}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
