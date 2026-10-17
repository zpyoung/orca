import { Repeat } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'

/**
 * "Loop…" entry for the tab bar + menu. The dialog opens on the next frame so the menu's
 * focus restore to its trigger finishes first and cannot pull focus out of the dialog.
 */
export function LoopMenuItem({
  worktreeId,
  groupId
}: {
  worktreeId: string
  groupId: string
}): React.JSX.Element {
  const openLoopSetup = useAppStore((s) => s.openLoopSetup)
  return (
    <DropdownMenuItem
      onSelect={() => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => openLoopSetup({ worktreeId, groupId }))
        })
      }}
      className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
    >
      <Repeat className="size-4" />
      {translate('fork.loops.setup.menuItem', 'Loop…')}
    </DropdownMenuItem>
  )
}
