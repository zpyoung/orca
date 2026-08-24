import { AskCard } from './AskCard'
import { useAskPaneDock } from './use-ask-pane-dock'

/**
 * Bottom-docked ask card for one terminal pane. The caller portals this into `pane.container`
 * (tech.md § C8); there is no composer in a terminal pane to yield to.
 */
export function AskTerminalPaneDock({ paneKey }: { paneKey: string }): React.JSX.Element | null {
  const { model, isSubmitting, onSubmit, onCancel, onDraftChange } = useAskPaneDock(paneKey)
  if (!model) {
    return null
  }
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 z-40 flex justify-center">
      <div className="pointer-events-auto w-full max-w-xl">
        <AskCard
          key={model.askId}
          model={model}
          onSubmit={onSubmit}
          onCancel={onCancel}
          isSubmitting={isSubmitting}
          onDraftChange={onDraftChange}
        />
      </div>
    </div>
  )
}
