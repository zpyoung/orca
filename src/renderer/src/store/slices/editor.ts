/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  createRecentlyClosedTabPositionIndex,
  getRecentlyClosedTabPosition,
  restoreRecentlyClosedTabPosition,
  pushRecentlyClosedTabKind
} from './recently-closed-tabs'
import type { RecentlyClosedTabPosition } from './recently-closed-tabs'
import { joinPath } from '@/lib/path'
import { toast } from 'sonner'
import {
  areLocalWindowsWslPathAliases,
  isPathInsideOrEqual
} from '../../../../shared/cross-platform-path'
import { resolveMarkdownLinkTarget } from '@/components/editor/markdown-internal-links'
import {
  buildCheckRunDetailsTabId,
  createCheckRunDetailsRequestId,
  getCheckRunDetailsTabLabel,
  isSameGitHubRepository,
  isSameGitLabProjectRef,
  type CheckRunDetailsTabPatch,
  type OpenCheckRunDetailsState
} from '@/components/editor/check-run-details-tab'
import { openHttpLink, type HttpLinkSourceOwner } from '@/lib/http-link-routing'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { isLocalPathOpenBlocked, showLocalPathOpenBlockedToast } from '@/lib/local-path-open-guard'
import { detectLanguage } from '@/lib/language-detect'
import type { SearchResult } from '../../../../shared/code-search-types'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary,
  GitCommitCompareSummary
} from '../../../../shared/git-diff-compare-types'
import type {
  GitBranchLineTotal,
  GitConflictKind,
  GitConflictOperation,
  GitConflictResolutionStatus,
  GitConflictStatusSource,
  GitStatusEntry,
  GitStatusResult,
  GitUpstreamStatus
} from '../../../../shared/git-status-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Tab, TabGroup, WorkspaceVisibleTabType } from '../../../../shared/tab-types'
import type {
  ActiveRightSidebarTab,
  RightSidebarExplorerView
} from '../../../../shared/ui-chrome-types'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../../../shared/workspace-session-state-types'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { clampMarkdownTocPanelWidth } from '../../../../shared/markdown-toc-panel-width'
import {
  clampCombinedDiffFileTreeWidth,
  COMBINED_DIFF_FILE_TREE_DEFAULT_WIDTH
} from '../../../../shared/combined-diff-file-tree-width'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoteOpKind } from '@/components/right-sidebar/source-control-primary-action'
import { invalidateAutomaticPushTargetUpstreamStatusCache } from '@/components/right-sidebar/push-target-upstream-refresh-cache'
import {
  isNonFastForwardRemoteError,
  markSyncPushStageError,
  resolveRemoteOperationErrorMessage
} from '@/lib/source-control-remote-error'
import { shouldForcePushWithLeaseForUpstream } from '../../../../shared/git-upstream-status'
import {
  fastForwardRuntimeGit,
  fetchRuntimeGit,
  getRuntimeGitUpstreamStatus,
  pullRuntimeGit,
  pushRuntimeGit,
  rebaseRuntimeGitFromBase
} from '@/runtime/runtime-git-client'
import {
  deleteRuntimePath,
  deleteRuntimeRelativePath,
  statRuntimePath
} from '@/runtime/runtime-file-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { notifyHostOfMirroredEditorClose } from '@/runtime/close-mirrored-editor-tab'
import {
  findWorktreeById,
  getRepoIdFromWorktreeId,
  type ActiveWorktreeStateTransition
} from './worktree-helpers'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getSettingsForWorktreeRuntimeOwner
} from '@/lib/worktree-runtime-owner'
import { loadGitLabJobLogDetails } from '@/runtime/gitlab-job-trace-client'
import {
  addAdditionalValidWorkspaceKeys,
  type WorkspaceSessionHydrationOptions
} from '@/lib/workspace-session-hydration-keys'
import { buildValidWorktreeIdsForSessionHydration } from './degraded-repo-worktree-validity'
import { createUntitledMarkdownFileWithTemplateSelection } from '@/lib/create-untitled-markdown'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { translate } from '@/i18n/i18n'
import type { FileSearchResultOwner } from '@/lib/file-search-result-owner'
import type { EditorFileOperationProvenance } from '@/lib/editor-file-operation-owner'
import {
  assertEditorFileOperationCurrent,
  captureEditorFileOperationProvenance,
  getEditorFileOperationContext
} from '@/lib/editor-file-operation-owner'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { pruneTabGroupLayoutForGroups } from './tabs-hydration'
import { sanitizeRecentTabIds } from './tab-group-state'
import { isLocalWindowsDesktopClient } from '@/lib/desktop-window-chrome'

export type {
  ActiveRightSidebarTab,
  RightSidebarExplorerView,
  RightSidebarTab
} from '../../../../shared/ui-chrome-types'

export type {
  ActivityBarPosition,
  ClosedEditorTabSnapshot,
  CombinedDiffSkippedConflict,
  CommitCompareSnapshot,
  ConflictReviewEntry,
  ConflictReviewState,
  DiffSource,
  EditorViewMode,
  MarkdownViewMode,
  OpenConflictMetadata,
  OpenFile,
  BranchCompareSnapshot
} from './editor/types/open-file'

export type { EditorSlice } from './editor/types/editor-slice'

export type {
  PendingEditorFocusRequest,
  PendingEditorReveal
} from './editor/types/pending-editor-reveal'

export type { OpenFilePathRekey, RekeyOpenFilesResult } from './editor/types/open-file-path-rekey'

export type {
  RestoredEditorOwnerMigration,
  RestoredEditorOwnerResult
} from './editor/types/restored-editor-owner'

export {
  buildDiffEditorFileId,
  buildOwnedEditorFileId,
  resolveEditorFileIdForOwner
} from './editor/file-ids/editor-file-ids'

export { createEditorSlice } from './editor/create-editor-slice'
