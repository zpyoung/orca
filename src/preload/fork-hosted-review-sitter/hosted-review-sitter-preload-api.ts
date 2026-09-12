import { ipcRenderer } from 'electron'
import {
  HOSTED_REVIEW_SITTER_CHANNELS,
  type HostedReviewSitterApi
} from '../../shared/fork-hosted-review-sitter/api'

/** Build the narrow IPC bridge for the main-owned hosted-review sitter service. */
export function buildHostedReviewSitterApi(): HostedReviewSitterApi {
  return {
    list: () => ipcRenderer.invoke(HOSTED_REVIEW_SITTER_CHANNELS.list),
    arm: (input) => ipcRenderer.invoke(HOSTED_REVIEW_SITTER_CHANNELS.arm, input),
    stop: (id) => ipcRenderer.invoke(HOSTED_REVIEW_SITTER_CHANNELS.stop, { id }),
    stopAll: () => ipcRenderer.invoke(HOSTED_REVIEW_SITTER_CHANNELS.stopAll),
    approve: (id, scope) =>
      ipcRenderer.invoke(HOSTED_REVIEW_SITTER_CHANNELS.approve, { id, scope }),
    ledger: (id) => ipcRenderer.invoke(HOSTED_REVIEW_SITTER_CHANNELS.ledger, { id })
  }
}
