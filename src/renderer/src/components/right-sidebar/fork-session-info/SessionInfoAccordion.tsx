import { useEffect } from 'react'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import { translate } from '@/i18n/i18n'
import type { SessionInfo } from '../../../../../shared/fork-session-info/session-info-types'
import type { FocusedSessionSelection } from './focused-session-info'
import type { SessionInfoSectionId } from './session-info-accordion-state'
import type { HooksAndMcpLoadState } from './use-hooks-and-mcp'
import { SessionInfoFilesSection, SessionInfoHooksSection } from './SessionInfoFilesHooksSections'
import { SessionInfoIdentitySection } from './SessionInfoIdentitySection'
import { SessionInfoLiveActivitySection } from './SessionInfoLiveActivitySection'
import {
  SessionInfoContextSection,
  SessionInfoUsageSection
} from './SessionInfoUsageContextSections'

function SessionSection({
  id,
  title,
  children
}: {
  id: SessionInfoSectionId
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <AccordionItem value={id}>
      <AccordionTrigger className="px-3 text-xs">{title}</AccordionTrigger>
      <AccordionContent className="px-3">{children}</AccordionContent>
    </AccordionItem>
  )
}

export function SessionInfoAccordion({
  info,
  selection,
  openSections,
  onOpenSectionsChange,
  hooksState
}: {
  info: SessionInfo
  selection: FocusedSessionSelection
  openSections: SessionInfoSectionId[]
  onOpenSectionsChange: (sections: string[]) => void
  hooksState: HooksAndMcpLoadState & {
    load: () => void
    enableStatusLine: () => void
  }
}): React.JSX.Element {
  const showHooks =
    (info.adapterId === 'claude' && selection.isLocalExecution) ||
    (Boolean(selection.workspaceRoot) &&
      (selection.isLocalExecution || Boolean(selection.connectionId)))
  const loadHooks = hooksState.load
  useEffect(() => {
    if (showHooks && openSections.includes('hooks')) {
      loadHooks()
    }
  }, [loadHooks, openSections, showHooks])

  return (
    <Accordion type="multiple" value={openSections} onValueChange={onOpenSectionsChange}>
      {info.identity ? (
        <SessionSection id="identity" title={translate('fork.sessionInfo.identity', 'Identity')}>
          <SessionInfoIdentitySection identity={info.identity} selection={selection} />
        </SessionSection>
      ) : null}
      {info.usage ? (
        <SessionSection id="usage" title={translate('fork.sessionInfo.usage', 'Usage')}>
          <SessionInfoUsageSection usage={info.usage} />
        </SessionSection>
      ) : null}
      {info.liveActivity ? (
        <SessionSection
          id="live"
          title={translate('fork.sessionInfo.liveActivity', 'Live activity')}
        >
          <SessionInfoLiveActivitySection activity={info.liveActivity} />
        </SessionSection>
      ) : null}
      {info.context ? (
        <SessionSection id="context" title={translate('fork.sessionInfo.context', 'Context')}>
          <SessionInfoContextSection context={info.context} />
        </SessionSection>
      ) : null}
      {info.filesTouched ? (
        <SessionSection
          id="files"
          title={translate('fork.sessionInfo.filesTouched', 'Files touched')}
        >
          <SessionInfoFilesSection files={info.filesTouched} />
        </SessionSection>
      ) : null}
      {showHooks ? (
        <SessionSection id="hooks" title={translate('fork.sessionInfo.hooksAndMcp', 'Hooks & MCP')}>
          <SessionInfoHooksSection
            loadState={hooksState}
            onRetry={hooksState.load}
            onEnableStatusLine={hooksState.enableStatusLine}
          />
        </SessionSection>
      ) : null}
    </Accordion>
  )
}
