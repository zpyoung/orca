import type { SessionInfoLiveActivity } from '../../../../../shared/fork-session-info/session-info-types'
import type { AgentStatusState } from '../../../../../shared/agent-status-types'
import { translate } from '@/i18n/i18n'
import { SessionInfoAsOf, SessionInfoRow } from './SessionInfoRows'

function stateLabel(state: AgentStatusState): string {
  switch (state) {
    case 'working':
      return translate('fork.sessionInfo.stateWorking', 'Working')
    case 'blocked':
      return translate('fork.sessionInfo.stateBlocked', 'Blocked')
    case 'waiting':
      return translate('fork.sessionInfo.stateWaiting', 'Waiting')
    case 'done':
      return translate('fork.sessionInfo.stateDone', 'Done')
  }
}

export function SessionInfoLiveActivitySection({
  activity
}: {
  activity: SessionInfoLiveActivity
}): React.JSX.Element {
  return (
    <div>
      <dl>
        {activity.state ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.state', 'State')}
            value={stateLabel(activity.state)}
          />
        ) : null}
        {activity.toolName ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.tool', 'Tool in flight')}
            value={activity.toolName}
          />
        ) : null}
        {activity.toolInput ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.toolInput', 'Input')}
            value={activity.toolInput}
            mono
            title={activity.toolInput}
          />
        ) : null}
        {activity.subagentCount !== undefined ? (
          <SessionInfoRow
            label={translate('fork.sessionInfo.subagents', 'Subagents')}
            value={activity.subagentCount}
          />
        ) : null}
      </dl>
      <SessionInfoAsOf updatedAt={activity.updatedAt} />
    </div>
  )
}
