import { translate } from '@/i18n/i18n'
import type { ForkSessionHandoffTemplate } from '../../../../shared/fork-session-handoff/handoff-settings-types'
import {
  DEFAULT_FORK_SESSION_HANDOFF_TEMPLATE_IDS,
  normalizeHandoffTemplates
} from '../../../../shared/fork-session-handoff/handoff-template-normalization'

/** Returns the translated built-in session-handoff templates. */
export function getDefaultHandoffTemplates(): ForkSessionHandoffTemplate[] {
  return [
    {
      id: DEFAULT_FORK_SESSION_HANDOFF_TEMPLATE_IDS[0],
      name: translate(
        'components.agentSessionContinuation.forkSessionHandoff.templateContinueImplementation',
        'Continue implementation'
      ),
      body: 'Continue the implementation from the stopping point. Verify existing changes before making new ones.'
    },
    {
      id: DEFAULT_FORK_SESSION_HANDOFF_TEMPLATE_IDS[1],
      name: translate(
        'components.agentSessionContinuation.forkSessionHandoff.templateReviewCompletedWork',
        'Review what was done'
      ),
      body: 'Review the work already completed. Focus on correctness, regressions, and missing tests before changing code.'
    },
    {
      id: DEFAULT_FORK_SESSION_HANDOFF_TEMPLATE_IDS[2],
      name: translate(
        'components.agentSessionContinuation.forkSessionHandoff.templateDebugFailure',
        'Debug the failure'
      ),
      body: 'Reproduce and diagnose the latest failure. Use the available status and changed paths to isolate the cause.'
    }
  ]
}

/** Resolves persisted input while preserving the absent-versus-empty catalog distinction. */
export function getHandoffTemplates(configured: unknown): ForkSessionHandoffTemplate[] {
  return Array.isArray(configured)
    ? normalizeHandoffTemplates(configured)
    : getDefaultHandoffTemplates()
}
