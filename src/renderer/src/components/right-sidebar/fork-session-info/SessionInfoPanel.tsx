import { Info } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { getFocusedSessionBindingKey, useFocusedSession } from './focused-session-info'
import { usePersistedSessionInfoSections } from './session-info-accordion-state'
import { useSessionInfo } from './use-session-info'
import { useHooksAndMcp } from './use-hooks-and-mcp'
import { SessionInfoAccordion } from './SessionInfoAccordion'
import { SessionInfoHeader } from './SessionInfoHeader'

function NoAgentState(): React.JSX.Element {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-5 py-12 text-center">
      <div className="mb-3 flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Info className="size-4" />
      </div>
      <h2 className="text-sm font-medium text-foreground">
        {translate('fork.sessionInfo.noAgent', 'No agent session')}
      </h2>
      <p className="mt-1 max-w-52 text-xs leading-relaxed text-muted-foreground">
        {translate(
          'fork.sessionInfo.noAgentDescription',
          'Focus a terminal pane with an agent session to inspect it here.'
        )}
      </p>
    </div>
  )
}

export default function SessionInfoPanel(): React.JSX.Element {
  const selection = useFocusedSession()
  const info = useSessionInfo(selection.paneKey, selection.status, selection.isLocalExecution)
  const { openSections, setOpenSections } = usePersistedSessionInfoSections()
  const bindingKey = getFocusedSessionBindingKey(selection.paneKey, selection.status)
  const hooksState = useHooksAndMcp({
    bindingKey,
    agentType: selection.status?.agentType,
    workspaceRoot: selection.workspaceRoot,
    connectionId: selection.connectionId,
    isLocalExecution: selection.isLocalExecution,
    canInspectMcp: selection.isLocalExecution || Boolean(selection.connectionId)
  })

  if (!selection.status || !info) {
    return <NoAgentState />
  }

  return (
    <div className="scrollbar-sleek h-full min-h-0 overflow-y-auto bg-background">
      <SessionInfoHeader info={info} />
      <SessionInfoAccordion
        info={info}
        selection={selection}
        openSections={openSections}
        onOpenSectionsChange={setOpenSections}
        hooksState={hooksState}
      />
    </div>
  )
}
