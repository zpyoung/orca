import { Bot } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import { countHeimdallAttention } from './fleet-selectors'

export function HeimdallSidebarNavEntry(): React.JSX.Element {
  const active = useAppStore((state) => state.activeView === 'heimdall')
  const openPage = useAppStore((state) => state.openHeimdallPage)
  const count = useAppStore((state) => countHeimdallAttention(state.heimdallFleet?.entries ?? []))
  return (
    <button
      type="button"
      onClick={openPage}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
        active
          ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
          : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
      )}
    >
      <Bot
        className={cn('size-4 shrink-0', !active && 'text-worktree-sidebar-foreground/30')}
        strokeWidth={active ? 2.25 : 1.75}
      />
      <span className="min-w-0 flex-1 truncate">
        {translate('fork.heimdall.sidebar.title', 'Heimdall')}
      </span>
      {count > 0 ? (
        <Badge
          variant="outline"
          className="h-5 min-w-5 border-status-warning-border bg-status-warning-background px-1.5 text-[10px] text-status-warning-foreground"
          aria-label={translate(
            'fork.heimdall.sidebar.attention',
            '{{count}} watchers need attention',
            { count }
          )}
        >
          {count > 99 ? '99+' : count}
        </Badge>
      ) : null}
    </button>
  )
}
