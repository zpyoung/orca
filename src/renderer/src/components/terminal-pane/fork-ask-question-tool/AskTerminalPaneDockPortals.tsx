import { createPortal } from 'react-dom'
import { makePaneKey } from '../../../../../shared/stable-pane-id'
import { AskTerminalPaneDock } from '../../fork-ask-question-tool/AskTerminalPaneDock'
import type { TerminalPaneController } from '../use-terminal-pane-controller'

export function AskTerminalPaneDockPortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  const { chatLeafId, effectiveChatViewMode, managedPanes, tabId } = controller
  return (
    <>
      {managedPanes.map((pane) => {
        if (effectiveChatViewMode && pane.leafId === chatLeafId) {
          return null
        }
        const paneKey = makePaneKey(tabId, pane.leafId)
        return createPortal(
          <AskTerminalPaneDock key={paneKey} paneKey={paneKey} />,
          pane.container,
          `ask-dock-${paneKey}`
        )
      })}
    </>
  )
}
