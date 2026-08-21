/* eslint-disable max-lines -- Why: the GH item dialog keeps its header, conversation, files, and checks tabs co-located so the read-only PR/Issue surface stays in one place while this view evolves. */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useShallow } from 'zustand/react/shallow'
import type { editor as monacoEditor } from 'monaco-editor'
import {
  ArrowRight,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  CircleDot,
  Copy,
  ExternalLink,
  FileText,
  FolderKanban,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  ListChecks,
  Link2,
  LoaderCircle,
  MessageSquare,
  MessageSquarePlus,
  MoveRight,
  PanelLeftOpen,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  UserMinus,
  UserPlus,
  Wrench,
  X
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ButtonGroup } from '@/components/ui/button-group'
import { Input } from '@/components/ui/input'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger
} from '@/components/ui/accordion'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import { DiffSectionItem } from '@/components/editor/DiffSectionItem'
import type { DecoratedDiffComment } from '@/components/diff-comments/useDiffCommentDecorator'
import {
  CombinedDiffFileTree,
  createCombinedDiffSectionIndexMap,
  handleCombinedDiffFileTreeNavigation
} from '@/components/editor/CombinedDiffFileTree'
import {
  getDiffSectionEstimatedHeight,
  isIntrinsicHeightImageDiff
} from '@/components/editor/diff-section-layout'
import type { DiffSection } from '@/components/editor/diff-section-types'
import { removeDiffSectionMeasuredHeight } from '@/components/editor/diff-section-height-cache'
import {
  getCombinedDiffBranchEntriesInTreeOrder,
  type CombinedDiffFileTreeEntry
} from '@/components/editor/combined-diff-file-tree-model'
import {
  getStoredTextDiffContent,
  getStoredTextDiffResult
} from '@/components/editor/large-diff-section-content'
import { CHECK_COLOR, CHECK_ICON } from '@/components/right-sidebar/checks-panel-content'
import {
  beginGitHubChecksTabDetails,
  createGitHubChecksTabState,
  resetGitHubChecksTabForSource,
  resolveGitHubChecksTabState,
  settleGitHubChecksTabDetails,
  toggleGitHubChecksTabExpandedKey,
  updateGitHubChecksTabLocalChecks,
  type CheckDetailsLoadState
} from '@/components/github-checks-tab-state'
import {
  clearGitHubLinkCopied,
  createGitHubLinkCopyState,
  markGitHubLinkCopied,
  resolveGitHubLinkCopyState
} from '@/components/github-link-copy-state'
import {
  resolveGitHubBodyDraft,
  shouldSyncGitHubBodyDraft
} from '@/components/github-body-draft-state'
import {
  filterPRCommentsByAudience,
  getPRCommentAudienceCounts,
  type PRCommentAudienceFilter
} from '../../../shared/pr-comment-audience'
import {
  getPRCommentAudienceEmptyLabel,
  getPrCommentAudienceFilters
} from '@/lib/pr-comment-audience-labels'
import { usePRBotAuthorOverrides } from '@/lib/pr-bot-author-overrides'
import {
  getPRCommentGroupCount,
  getPRCommentGroupId,
  getPRCommentGroupRoot,
  groupPRComments,
  isResolvedPRCommentGroup,
  type PRCommentGroup
} from '../../../shared/pr-comment-groups'
import {
  PR_COMMENT_OPEN_AUTHOR_CLASS,
  PR_COMMENT_RESOLVED_AUTHOR_CLASS,
  PR_COMMENT_RESOLVED_CONTAINER_CLASS
} from '@/lib/pr-comment-resolution-classes'
import {
  getCommentReplyTargetCandidates,
  resolveCommentReplyTarget
} from '@/components/comment-reply-target-state'
import {
  attachPRReviewReplyParent,
  canPostPRReviewThreadReply
} from '@/components/right-sidebar/pr-comments-ai-launch-ack'
import { buildPRCommentConversationReplyBody } from '@/components/right-sidebar/pr-comment-fixing-reply-body'
import { useAppStore } from '@/store'
import { useAllWorktrees } from '@/store/selectors'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { withGitHubCheckDetailsTimeout } from '@/runtime/github-check-details-timeout'
import { useRepoLabels, useRepoAssignees, useImmediateMutation } from '@/hooks/useIssueMetadata'
import { useRepoLabelsBySlug, useRepoAssigneesBySlug } from '@/hooks/useGitHubSlugMetadata'
import { GitHubMarkdownComposer } from '@/components/github/GitHubMarkdownComposer'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/comment-body-submit-state'
import { onGitHubWorkItemDetailsCacheMutation } from '@/lib/github-work-item-details-cache-events'
import { lookupGitHubWorkItemDetailsForSource } from '@/lib/github-work-item-source-lookup'
import {
  canUseGitHubRepoContext,
  getGitHubMutationRoutingSettings,
  getGitHubRuntimeRepoId,
  getGitHubSourceRuntimeHost
} from '@/lib/github-source-runtime-context'
import IssueSourceIndicator, { sameGitHubOwnerRepo } from '@/components/github/IssueSourceIndicator'
import {
  getGitHubPRReviewerRows,
  normalizeGitHubReviewerLogins,
  parseGitHubReviewerInputLogins
} from '@/components/github-pr-reviewer-display'
import {
  filterGitHubPRReviewerCandidates,
  getGitHubPRReviewerQueryState
} from '@/components/github/github-pr-reviewer-candidate-filter'
import { presentGitHubPRMergeState } from '@/components/github-pr-merge-state'
import {
  GITHUB_PR_MERGE_METHOD_LABELS,
  resolveGitHubPRMergeMethods
} from '../../../shared/github/pull-request-merge-methods'
import { githubRepoIdentityKey } from '../../../shared/github/repository-identity-key'
import {
  findGithubIssueWorkspaceAttachment,
  getGithubWorkItemWorkspaceAttachmentLabel
} from '@/lib/github-work-item-workspace-attachment'
import { startFixChecksAgent } from '@/lib/fix-checks-agent-launch'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { buildFixBrokenChecksPrompt, getBrokenChecks } from '@/components/pr-checks-fix-prompt'
import type { GitBranchChangeEntry, GitDiffResult } from '../../../shared/git-diff-compare-types'
import type { PRCheckDetail } from '../../../shared/github/check-types'
import type {
  GitHubIssueTimelineItem,
  GitHubIssueTimelineTarget,
  PRComment
} from '../../../shared/github/comment-types'
import type {
  GitHubAssignableUser,
  GitHubOwnerRepo,
  GitHubPRFile,
  GitHubPRFileContents,
  GitHubPRFileViewedState,
  GitHubPRMergeMethod
} from '../../../shared/github/pull-request-types'
import type { GitHubWorkItem, GitHubWorkItemDetails } from '../../../shared/github/work-item-types'
import {
  getTaskSourceCacheScope,
  getTaskSourceRuntimeSettings,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import { PER_REPO_FETCH_LIMIT } from '../../../shared/work-items'
import { translate } from '@/i18n/i18n'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import {
  buildTaskPageGitHubCloseUpdate,
  getTaskPageGitHubDuplicateCandidates,
  getTaskPageGitHubDuplicateTargetErrorMessage,
  validateTaskPageGitHubDuplicateTarget,
  type TaskPageGitHubCloseAction
} from '@/components/task-page-github-status-actions'
import { assertTaskPageGitHubDialogStateAuthority } from '@/components/task-page-github-dialog-state-authority'
import { sortChecksBySeverity } from '../../../shared/pr-check-severity-order'
import {
  getCheckConclusion,
  getCheckCountChips,
  getCheckCounts,
  getChecksSummaryLabel
} from '@/components/pr-check-counts'
import {
  normalizeItemDialogTab,
  parseOwnerRepoFromItemUrl,
  resolvePullRequestRepo,
  type GitHubWorkItemProjectOrigin,
  type ItemDialogTab
} from '@/components/github/github-work-item-identity'
import {
  addIssueCommentForRepo,
  addPRReviewCommentForRepo,
  addPRReviewCommentReplyForRepo,
  notifyWorkItemDetailsMutation,
  setPRFileViewedForRepo
} from '@/components/github/github-work-item-comment-mutations'
import {
  runIssueUpdate,
  runPullRequestStateUpdate,
  runWorkItemBodyUpdate
} from '@/components/github/github-work-item-edit-mutations'
import {
  PR_FILE_CONTENT_CACHE_MAX_BYTES,
  getRetainedPRFileContentsByteCount,
  isPRFileViewed
} from '@/components/github/pr-file-content-size'
import {
  PR_DIFF_OVERSCAN,
  getPRFileContentsRenderLimit,
  getPRFileDiffResult,
  getPRFileSectionKey,
  gitHubPRFileToBranchEntry,
  type PRFilesCombinedDiffViewerProps
} from '@/components/github/pr-file-diff-mapping'
import {
  buildRequestedReviewUsers,
  formatRelativeTime,
  getStateLabel,
  mergeReviewerSuggestions,
  ReviewerAvatar
} from '@/components/github/work-item-state-presentation'
import {
  formatCheckTimestamp,
  getCheckDetailsKey,
  getCheckStatusLabel
} from '@/components/github/pr-check-presentation'
import { CommentCodeContext } from '@/components/github/CommentCodeContext'
import { CommentReactions } from '@/components/github/CommentReactions'
import { PRAssigneesPanel } from '@/components/github/PRAssigneesPanel'
import { PRViewedCheckbox } from '@/components/github/PRViewedCheckbox'

export type { ItemDialogTab } from './github/github-work-item-identity'
export type { GitHubItemDialogProjectOrigin } from './github-item-dialog/load-item-details/github-item-dialog-types'
export { invalidateWorkItemDetailsCacheForKey } from './github-item-dialog/load-item-details/work-item-details-cache'

export default GitHubItemDialog
