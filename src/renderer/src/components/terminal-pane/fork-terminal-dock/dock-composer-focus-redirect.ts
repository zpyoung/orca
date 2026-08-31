const DOCK_COMPOSER_TEXTAREA_SELECTOR =
  '[data-terminal-dock]:not([data-terminal-dock-passthrough]) textarea:not(:disabled)'

type DockFocusablePane = {
  container: Pick<HTMLElement, 'querySelector'>
  terminal: { focus(): void }
}

function queryDockComposerTextarea(
  root: Pick<ParentNode, 'querySelector'> | null | undefined
): HTMLTextAreaElement | null {
  if (typeof root?.querySelector !== 'function') {
    return null
  }
  return root.querySelector<HTMLTextAreaElement>(DOCK_COMPOSER_TEXTAREA_SELECTOR)
}

/** Finds the enabled dock composer that belongs to the pane containing an xterm surface. */
export function findDockComposerTextarea(
  surface: Element | null | undefined
): HTMLTextAreaElement | null {
  if (!surface || typeof surface.closest !== 'function') {
    return null
  }
  const pane = surface.closest<HTMLElement>('.pane[data-leaf-id]')
  return queryDockComposerTextarea(pane)
}

/** Focuses a pane's dock composer when available, otherwise its terminal. */
export function focusPaneOrDockComposer(pane: DockFocusablePane | null | undefined): void {
  if (!pane) {
    return
  }
  const composer = queryDockComposerTextarea(pane.container)
  if (composer) {
    composer.focus()
    return
  }
  pane.terminal.focus()
}
