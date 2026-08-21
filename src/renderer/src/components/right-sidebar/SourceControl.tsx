import React from 'react'
import { SourceControlPanel } from './source-control/panel/panel'

import { stripBaseRef, useCreatePullRequestDialogFields } from './useCreatePullRequestDialogFields'
import { resolveCreateReviewDraftTitle } from './create-review-draft-title'
import { GitHistoryPanel, type GitHistoryPanelState } from './GitHistoryPanel'
import { useGitHistoryCommitActions } from './useGitHistoryCommitActions'
import { normalizeHostedReviewHeadRef } from '../../../../shared/hosted-review-refs'
import {
  isBehindOnlyUpstream,
  shouldForcePushWithLeaseForUpstream
} from '../../../../shared/git-upstream-status'
import type { DiffComment } from '../../../../shared/diff-comment-types'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary
} from '../../../../shared/git-diff-compare-types'
import type {
  GitConflictOperation,
  GitStatusEntry,
  GitUpstreamStatus
} from '../../../../shared/git-status-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { SourceControlViewMode } from '../../../../shared/ui-chrome-types'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type {
  HostedReviewCreationEligibility,
  HostedReviewInfo,
  HostedReviewProvider
} from '../../../../shared/hosted-review'
import { resolveHostedReviewCreationProvider } from '../../../../shared/hosted-review-creation-providers'
import { STATUS_COLORS, STATUS_LABELS } from './status-display'
import { isCustomAgentId } from '../../../../shared/commit-message-agent-spec'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { resolveSourceControlLaunchPlatform } from '@/lib/source-control-launch-platform'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  loadSessionCommitDrafts,
  saveSessionCommitDrafts
} from '@/lib/source-control-commit-draft-session'
import { hasExpandedCommitFailureDetails, summarizeCommitFailure } from './commit-failure-summary'
import {
  isSourceControlSplitOpenModifier,
  shouldOpenSourceControlRowAsPreview,
  toPermanentSourceControlRowOpenEvent,
  type SourceControlRowOpenEvent
} from './source-control-split-open'
import { SourceControlAgentActionDialog } from './SourceControlAgentActionDialog'
import {
  isPullPolicyRemoteActionError,
  PullPolicyRemoteActionNotice
} from './source-control-pull-policy-error-notice'
import { SourceControlTextGenerationDialog } from './SourceControlTextGenerationDialog'
import { CreateHostedReviewComposer } from './CreateHostedReviewComposer'
import { useHostedReviewStackParent } from './useHostedReviewStackParent'
import { resolveCreatedHostedReviewLink } from './source-control-created-review-link'
import {
  hasConfiguredCommitMessageGenerationDefaults,
  hasConfiguredSourceControlTextGenerationDefaults
} from './source-control-text-generation-defaults'
import { useSourceControlAi } from './use-source-control-ai'
import { translate } from '@/i18n/i18n'
import {
  localizedHostedReviewCopy,
  resolveSupportedHostedReviewCopyProvider
} from '@/i18n/hosted-review-localized-copy'
import {
  createCreatePrIntentRunToken,
  createPrIntentCurrentTargetConflictsWithToken,
  createPrIntentGitStatusMatchesToken,
  createPrIntentRunTokenMatches,
  getCreatePrIntentCommitFailureNoticeMessage,
  getCreatePrIntentStagePaths,
  resolveCreatePrIntentReviewBase,
  resolveCreatePrIntentGeneratedReviewFields,
  resolveCreatePrIntentRemoteStep,
  shouldAttemptCreateHostedReviewForIntent,
  shouldGenerateHostedReviewDetailsForIntent,
  type CreatePrIntentRunToken
} from './source-control-create-pr-intent-flow'
import { resolveVisibleCreatePrHeaderAction } from './source-control-create-pr-intent-state'
import { resolveBlockedCreateReviewNoticeMessage } from './source-control-create-review-blocked-action'
import {
  buildCreatePrIntentUnavailableEligibility,
  buildLoadingHostedReviewCreationEligibility,
  buildLocalBlockerHostedReviewCreationEligibility,
  resolveHostedReviewCreationProviderForTarget
} from './source-control-hosted-review-creation-eligibility-snapshot'
import {
  resolveCreatePrHeaderAction,
  resolveProvisionalHostedReviewProvider
} from './source-control-primary-create-pr-intent-action'
import {
  getNextSourceControlViewMode,
  shouldShowSourceControlCompareUnavailableCard,
  SourceControlHeaderToolbar
} from './source-control-header-toolbar'
import {
  hasPositiveHostedReviewNumberLink,
  hasResolvableHostedReviewPushTargetLink,
  hasUsableHostedReviewPushTarget,
  resolveHostedReviewActionUpstreamStatus,
  resolveHostedReviewStateForActions
} from './source-control-hosted-review-push-target'
import { buildSourceControlManualReviewUrlFromContext } from './source-control-manual-review-url'
import { parseRemoteRepo } from './source-control-remote-repo'
import { setBranchLineTotalMergeBase } from './branch-line-total-request-gate'
export { HostedReviewHeaderLink } from './hosted-review-header-chrome'
import {
  createRunningCommitMessageGenerationRecord,
  getCommitMessageGenerationRecordKey,
  markCommitMessageGenerationHydrated,
  resolveCommitMessageGenerationCancel,
  resolveCommitMessageGenerationFailure,
  resolveCommitMessageGenerationSuccess,
  type CommitMessageGenerationRecord
} from '@/store/slices/commit-message-generation'
import {
  createRunningPullRequestGenerationRecord,
  getPullRequestGenerationRecordKey,
  getPullRequestGenerationSeedRestoreKey,
  markPullRequestGenerationTerminalSeedRestored,
  resolvePullRequestGenerationCancel,
  resolvePullRequestGenerationFailure,
  resolvePullRequestGenerationSuccess,
  shouldHydratePullRequestGenerationResult,
  type PullRequestFieldRevisions,
  type PullRequestGenerationContext,
  type PullRequestGenerationFields
} from '@/store/slices/pull-request-generation'
import {
  captureSourceControlRecoveryEntrySnapshot,
  type SourceControlActionError,
  type SourceControlRecoveryStatusEntry
} from './source-control-action-error'
import {
  deriveSourceControlPushRecovery,
  getSourceControlRecoveryFailureKindLabel,
  type SourceControlPushRecovery
} from './source-control-push-recovery'
import { SourceControlRecoveryNotice } from './source-control-recovery-notice'

export {
  appendCommitFailureCustomInstruction,
  appendPushFailureCustomInstruction,
  buildCommitFailureAgentCommandInput,
  buildFixCommitFailurePrompt,
  buildFixPushFailurePrompt,
  buildPushFailureAgentCommandInput,
  buildResolveConflictsPrompt,
  buildResolvePullRequestConflictsPrompt
} from './source-control/ai/prompts'
export {
  hasConfiguredCommitMessageGenerationDefaults,
  hasConfiguredSourceControlTextGenerationDefaults
} from './source-control/ai/text-generation-defaults'

function SourceControlInner(): React.JSX.Element {
  return <SourceControlPanel />
}
const SourceControl = React.memo(SourceControlInner)
export default SourceControl
