import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { resolveTerminalDockShortcutAction } from './terminal-pane-dock-shortcuts'

function shortcutPlatform(): NodeJS.Platform {
  if (navigator.userAgent.includes('Mac')) {
    return 'darwin'
  }
  return navigator.userAgent.includes('Windows') ? 'win32' : 'linux'
}

export function useTerminalDockShortcutListener(args: {
  enabled: boolean
  containerRef: React.RefObject<HTMLDivElement | null>
  toggleDock: () => void
  togglePassthrough: () => void
}): void {
  const { enabled, containerRef, toggleDock, togglePassthrough } = args
  useEffect(() => {
    if (!enabled) {
      return undefined
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      const container = containerRef.current
      if (!container || !(event.target instanceof Node) || !container.contains(event.target)) {
        return
      }
      const action = resolveTerminalDockShortcutAction(
        event,
        shortcutPlatform(),
        useAppStore.getState().keybindings
      )
      if (!action) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (action === 'toggleDock') {
        toggleDock()
      } else {
        togglePassthrough()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [containerRef, enabled, toggleDock, togglePassthrough])
}
