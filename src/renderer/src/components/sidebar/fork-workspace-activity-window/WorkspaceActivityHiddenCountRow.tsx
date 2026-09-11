import { useCallback } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

export function WorkspaceActivityHiddenCountRow({ count }: { count: number }) {
  const setWorkspaceActivityWindow = useAppStore((state) => state.setWorkspaceActivityWindow)
  const clearActivityWindow = useCallback(() => {
    setWorkspaceActivityWindow('all')
  }, [setWorkspaceActivityWindow])
  if (count <= 0) {
    return null
  }
  return (
    <button
      type="button"
      className="w-full px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground"
      onClick={clearActivityWindow}
    >
      {translate(
        'auto.components.sidebar.WorkspaceActivityHiddenCountRow.hidden',
        '{{count}} workspaces hidden by activity window',
        { count }
      )}
    </button>
  )
}
