import { homedir } from 'node:os'
import { app } from 'electron'
import {
  buildHostedReviewSitterDebugReport,
  type HostedReviewSitterDebugReport,
  type HostedReviewSitterDebugReportInput
} from '../../shared/fork-hosted-review-sitter/debug-report'

export type HostedReviewSitterMainDebugInput = Omit<
  HostedReviewSitterDebugReportInput,
  'generatedAtMs' | 'appVersion' | 'platform' | 'homeDirectory'
>

/** Add process-owned metadata to the kind's deterministic debug report. */
export function buildSitterDebugReport(
  input: HostedReviewSitterMainDebugInput
): HostedReviewSitterDebugReport {
  return buildHostedReviewSitterDebugReport({
    ...input,
    generatedAtMs: Date.now(),
    appVersion: app.getVersion(),
    platform: process.platform,
    homeDirectory: homedir()
  })
}
