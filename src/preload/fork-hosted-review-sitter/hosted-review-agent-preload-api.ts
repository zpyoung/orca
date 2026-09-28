import { ipcRenderer } from 'electron'
import {
  HOSTED_REVIEW_AGENT_CHANNELS,
  type HostedReviewAgentApi
} from '../../shared/fork-hosted-review-sitter/api'

/** Build the renderer bridge for person-requested hosted-review fix sessions. */
export function buildHostedReviewAgentApi(): HostedReviewAgentApi {
  return {
    launchFix: (input) => ipcRenderer.invoke(HOSTED_REVIEW_AGENT_CHANNELS.launchFix, input)
  }
}
