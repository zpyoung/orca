import { buildClaudeSessionInfo } from './claude-session-info-adapter'
import { registerSessionInfoAdapter } from './session-info-adapter-registry'

registerSessionInfoAdapter({
  id: 'claude',
  supports: (agentType) => agentType === 'claude',
  build: buildClaudeSessionInfo
})

export { buildSessionInfo } from './session-info-adapter-registry'
export type * from './session-info-types'
