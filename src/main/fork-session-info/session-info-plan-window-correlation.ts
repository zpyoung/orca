import type { ClaudeStatusLineRateLimits } from '../../shared/claude-statusline-rate-limits'
import type { RateLimitService } from '../rate-limits/service'
import { sessionInfoService } from './session-info-service'

/** Feed accepted plan windows to the account-neutral pane correlation marker. */
export function ingestSessionInfoPlanWindows(
  rateLimits: RateLimitService | null | undefined,
  event: ClaudeStatusLineRateLimits
): void {
  if (rateLimits?.ingestLiveClaudeRateLimits(event)) {
    sessionInfoService.confirmPlanWindowsForAccount(event.configDir)
  }
}
