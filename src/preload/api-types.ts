/* eslint-disable max-lines -- Why: the preload contract is intentionally centralized in one declaration file so renderer and preload stay in lockstep when IPC surfaces change. */
import type {
  CreateHostedReviewArgs,
  CreateHostedReviewResult,
  CreateStackedHostedReviewArgs,
  CreateStackedHostedReviewResult,
  HostedReviewCreationEligibility,
  HostedReviewCreationEligibilityArgs,
  HostedReviewForBranchArgs,
  HostedReviewInfo,
  HostedReviewProvider
} from '../shared/hosted-review'
import type {
  BitbucketConnectArgs,
  BitbucketConnectionStatus
} from '../shared/bitbucket-credentials'
import type { NativeFileDropPayload } from '../shared/native-file-drop'
import type { ComputerAwakeStatus } from '../shared/computer-awake-mode'
import type { BrowserFindSource } from '../shared/browser-find-source'
import type {
  DashboardRevealAgentArgs,
  DashboardSleepWorkspaceArgs,
  DashboardSnapshot,
  DashboardSpawnAgentArgs
} from '../shared/dashboard-snapshot'
import type {
  TerminalPreviewConnectResult,
  TerminalPreviewDataPayload
} from '../shared/terminal-preview'
import type {
  TerminalTabCloseRequest,
  TerminalTabCloseResponse
} from '../shared/terminal-tab-close'
import type { TerminalTabCreateReply } from '../shared/terminal-reveal-identity'
import type {
  LocalLogTailChangedPayload,
  LocalLogTailReadArgs,
  LocalLogTailReadResult,
  LocalLogTailWatchArgs
} from '../shared/local-log-tail-types'
import type { ReadClipboardTextOptions } from '../shared/clipboard-text'
import type { AppIdentity } from '../shared/app-identity'
import type { ReleaseChannel } from '../shared/release-channel'
import type {
  ForgetRemovedWorktreesForExecutionHostArgs,
  ForgetRemovedWorktreesForExecutionHostResult,
  HostQualifiedKnownWorktreeResult,
  HostQualifiedDetectedWorktreeResult,
  LegacyDetectedWorktreeRequest,
  ListKnownWorktreesForExecutionHostArgs,
  ListDetectedWorktreesArgs,
  ProviderRequestId
} from '../shared/detected-worktree-provider-contract'
import type {
  HostRepoCatalogSnapshot,
  ListReposForExecutionHostArgs
} from '../shared/host-repo-catalog-contract'
import type {
  HostLineageSnapshot,
  ListDesktopLineageForHostArgs
} from '../shared/host-lineage-contract'
import type {
  WriteTerminalRenderDesyncEvidenceArgs,
  WriteTerminalRenderDesyncEvidenceResult
} from '../shared/terminal-render-desync-evidence'
import type { MobileRelayStatus } from '../shared/mobile-relay-status'
import type { MobilePairingConnectionMode } from '../shared/mobile-pairing-connection-mode'
import type { RuntimePairingReach } from '../shared/runtime-pairing-reach'
import type { MobileRelayMintFailure } from '../shared/mobile-relay-mint-failure'
import type { VerifyAndAddRuntimeEnvironmentResult } from '../shared/remote-pairing-verification'
import type {
  SshMutationExpectation,
  SshConnectionState,
  SshConfigHostListArgs,
  SshConfigHostListResult,
  SshConfigHostResolution,
  SshConfigImportResult,
  SshTargetAddResult,
  SshTarget,
  PortForwardEntry,
  EnrichedDetectedPort
} from '../shared/ssh-types'
import type {
  CreateLocalOrcaProfileArgs,
  CreateLocalOrcaProfileResult,
  CreateCloudLinkedOrcaProfileArgs,
  CreateCloudLinkedOrcaProfileResult,
  ConnectCurrentOrcaProfileResult,
  FindOrcaProfileProjectsByPathArgs,
  FindOrcaProfileProjectsByPathResult,
  OrcaProfileListResult,
  OrcaProfileAuthStatus,
  RefreshCurrentOrcaProfileAuthResult,
  SelectOrcaProfileOrgArgs,
  SelectOrcaProfileOrgResult,
  SignOutCurrentOrcaProfileResult,
  SwitchOrcaProfileArgs,
  SwitchOrcaProfileResult,
  TransferOrcaProfileProjectArgs,
  TransferOrcaProfileProjectResult,
  OrcaProfileOrgInviteRevokeArgs,
  OrcaProfileOrgMemberChangeRoleArgs,
  OrcaProfileOrgMemberInviteArgs,
  OrcaProfileOrgMemberMutationResult,
  OrcaProfileOrgMemberRemoveArgs,
  OrcaProfileOrgMembersListArgs,
  OrcaProfileOrgMembersListResult
} from '../shared/orca-profiles'
import type { TerminalPaneSplitSource } from '../shared/feature-education-telemetry'
import type { TaskSourceContext } from '../shared/task-source-context'
import type { LinearIssueAttributeFilter } from '../shared/linear-issue-attribute-filter'
import type { ProjectExecutionRuntimeResolution } from '../shared/project-execution-runtime'
import type { StartupCommandDelivery } from '../shared/codex-startup-delivery'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../shared/agent-session-resume'
import type {
  PluginPanelActionOutcome,
  PluginPanelEntry
} from '../shared/plugins/plugin-panel-bridge'
import type { PluginConsentRequest } from '../shared/plugins/plugin-consent-request'
import type { PluginLanguagePackRegistration } from '../shared/plugins/plugin-language-pack-artifact'
import type { PluginChangeEvent } from '../shared/plugins/plugin-change-event'
import type { PluginManifest } from '../shared/plugins/plugin-manifest'
import type { PluginMarketplaceGitSource } from '../shared/plugins/plugin-marketplace'
import type {
  LocalhostWorktreeLabelResult,
  LocalhostWorktreeLabelRoute
} from '../shared/localhost-worktree-labels'
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusRequest
} from '../shared/folder-workspace-path-status'
import type {
  BaseRefDefaultResult,
  BaseRefSearchResult,
  BrowserCookieImportResult,
  BrowserCertificateFailure,
  BrowserCertificateProceedResult,
  BrowserLoadError,
  BrowserSessionProfile,
  BrowserSessionProfileCreateOptions,
  BrowserSessionProfileScope,
  BrowserSessionProfileSource,
  BrowserViewportOverride,
  ClaudeRateLimitAccountsState,
  ClassifiedError,
  CodexRateLimitAccountsState,
  CreateWorktreeArgs,
  CreateWorktreeResult,
  CustomPet,
  DetectedWorktreeListResult,
  DirEntry,
  FilesystemPathFlavor,
  ForceDeleteWorktreeBranchResult,
  FsChangedPayload,
  GhosttyImportPreview,
  GlobalSettings,
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitConflictOperation,
  GitDiffResult,
  GitForkSyncExpectedUpstream,
  GitForkSyncResult,
  GitPushTarget,
  GitStagingArea,
  GitStatusResult,
  GitUpstreamStatus,
  GitHubAssignableUser,
  GitHubCreateIssueResult,
  GitHubPRFile,
  GitHubPRFileContents,
  GitHubPrStartPoint,
  GitHubPRReviewCommentInput,
  GitHubCommentResult,
  GitHubOwnerRepo,
  GitHubWorkItem,
  GitHubWorkItemDetails,
  GitHubViewer,
  GitLabAssignableUser,
  GitLabAuthDiagnostic,
  GitLabCommentResult,
  GitLabDiscussionResolveResult,
  GitLabIssueInfo,
  GitLabIssueUpdate,
  GitLabJobTraceResult,
  GitLabMRInlineCommentInput,
  GitLabMRReviewersUpdateResult,
  GitLabMRUpdate,
  GitLabProjectRef,
  GitLabRetryJobResult,
  GitLabTodo,
  GitLabViewer,
  GitLabWorkItem,
  GitLabWorkItemDetails,
  GetGitLabRateLimitResult,
  ListMergeRequestsResult,
  MRInfo,
  MRListState,
  ListWorkItemsResult,
  IssueInfo,
  JiraComment,
  JiraConnectionStatus,
  JiraCreateField,
  JiraCreateIssueArgs,
  JiraIssue,
  JiraIssueFilter,
  JiraIssueType,
  JiraProjectStatusOrder,
  JiraIssueUpdate,
  JiraPriority,
  JiraProject,
  JiraSiteSelection,
  JiraTransition,
  JiraUser,
  JiraViewer,
  LinearViewer,
  LinearCollectionResult,
  LinearConnectionStatus,
  LinearCustomViewModel,
  LinearCustomViewSummary,
  LinearWorkspaceSelection,
  LinearIssue,
  LinearIssueUpdate,
  LinearComment,
  LinearWorkflowState,
  LinearLabel,
  LinearMember,
  LinearProjectDetail,
  LinearProjectSummary,
  LinearTeam,
  MarkdownDocument,
  FloatingTerminalCwdRequest,
  GitHubIssueUpdate,
  GitHubReactionContent,
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEnqueueResult,
  GitHubPRRefreshEvent,
  GitHubPRRefreshReason,
  GetRateLimitResult,
  NotificationDispatchRequest,
  NotificationDispatchResult,
  NotificationDeliveryProbeResult,
  NotificationDismissResult,
  NotificationPermissionStatusResult,
  NotificationSoundResult,
  OnboardingState,
  OrcaHooks,
  PathSource,
  PersistedUIState,
  PRCheckDetail,
  PRCheckRunDetails,
  PRComment,
  PRInfo,
  PRRefreshOutcome,
  Project,
  ProjectUpdateArgs,
  Repo,
  ProjectGroup,
  ProjectHostSetup,
  ProjectHostSetupCreateArgs,
  ProjectHostSetupCreateResult,
  ProjectHostSetupDeleteArgs,
  ProjectHostSetupDeleteResult,
  ProjectHostSetupExistingFolderArgs,
  ProjectHostSetupResult,
  ProjectHostSetupUpdateArgs,
  ProjectHostSetupUpdateResult,
  FolderWorkspace,
  ProjectGroupImportResult,
  ProjectGroupImportMode,
  ShellHydrationFailureReason,
  SparsePreset,
  SearchOptions,
  NestedRepoScanResult,
  SearchResult,
  StatsSummary,
  MemorySnapshot,
  TerminalDockPaneState,
  TuiAgent,
  ReleaseBuildListResult,
  UpdateCheckOptions,
  UpdateStatus,
  Worktree,
  WorktreeBaseStatusEvent,
  WorktreeHeadIdentity,
  WorktreeLineage,
  WorkspaceLineage,
  WorktreeMeta,
  WorktreeRemoteBranchConflictEvent,
  RemoveWorktreeResult,
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch,
  WorktreeStartupLaunch,
  WorkspaceSessionPatch,
  WorkspaceSessionState,
  LinuxPackageInstallInstructions
} from '../shared/types'
import type { PtyModelRestoreNeededEvent } from '../shared/pty-model-restore-marker'
import type { PtyListedSession } from '../shared/pty-listed-session'
import type {
  PtyRendererDeliveryHealthReply,
  PtyRendererDeliveryStateReport
} from '../shared/pty-renderer-delivery-health'
import type { TerminalViewAttributes } from '../shared/terminal-view-attributes'
import type { PtyMainDeliveryDiagnostics } from '../shared/pty-delivery-diagnostics'
import type {
  WarpThemeImportPreview,
  WarpThemeImportSource
} from '../shared/terminal-custom-themes'

import type { SetupScriptImportCandidate } from '../shared/setup-script-imports'
import type { GitHistoryOptions, GitHistoryResult } from '../shared/git-history'
import type { PublicKnownRuntimeEnvironment } from '../shared/runtime-environments'
import type { EphemeralVmRecipeDoctorResult } from '../shared/ephemeral-vm-recipes'
import type { EphemeralVmRecipeResultWarning } from '../shared/ephemeral-vm-recipe-diagnostics'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import type { RuntimeAccessGrant } from '../shared/runtime-access-grants'
import type { RuntimeRpcResponse } from '../shared/runtime-rpc-envelope'
import type { ExecutionHostId } from '../shared/execution-host'
import type { FeatureInteractionId } from '../shared/feature-interactions'
import type {
  AddIssueCommentBySlugArgs,
  ClearProjectItemFieldArgs,
  DeleteIssueCommentBySlugArgs,
  GetProjectViewTableArgs,
  GetProjectViewTableResult,
  GitHubProjectCommentMutationResult,
  GitHubProjectMutationResult,
  ListAccessibleProjectsArgs,
  ListAccessibleProjectsResult,
  ListAssignableUsersBySlugArgs,
  ListAssignableUsersBySlugResult,
  ListIssueTypesBySlugArgs,
  ListIssueTypesBySlugResult,
  ListLabelsBySlugArgs,
  ListLabelsBySlugResult,
  ListProjectViewsArgs,
  ListProjectViewsResult,
  ProjectWorkItemDetailsBySlugArgs,
  ProjectWorkItemDetailsBySlugResult,
  ResolveProjectRefArgs,
  ResolveProjectRefResult,
  UpdateIssueBySlugArgs,
  UpdateIssueCommentBySlugArgs,
  UpdateIssueTypeBySlugArgs,
  UpdatePullRequestBySlugArgs,
  UpdateProjectItemFieldArgs
} from '../shared/github-project-types'
import type {
  RichMarkdownContextMenuCommandPayload,
  RichMarkdownContextMenuTableTarget
} from '../shared/rich-markdown-context-menu'
import type {
  BrowserSetGrabModeArgs,
  BrowserSetGrabModeResult,
  BrowserAwaitGrabSelectionArgs,
  BrowserGrabResult,
  BrowserCancelGrabArgs,
  BrowserCaptureSelectionScreenshotArgs,
  BrowserCaptureSelectionScreenshotResult,
  BrowserExtractHoverArgs,
  BrowserExtractHoverResult
} from '../shared/browser-grab-types'
import type {
  BrowserContextMenuDismissedEvent,
  BrowserContextMenuRequestedEvent,
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent,
  BrowserDownloadRequestedEvent,
  BrowserPermissionDeniedEvent,
  BrowserPopupEvent
} from '../shared/browser-guest-events'
import type { ElectronAPI } from '@electron-toolkit/preload'
import type {
  ClaudeAccountsApi,
  CodexAccountsApi,
  CodexConfigSyncApi,
  GrokAccountsApi,
  MinimaxCredentialsApi
} from './api/agent-account-api'
import type { AgentHooksApi, HooksApi } from './api/agent-hook-api'
import type { SkillsApi } from './api/agent-skill-api'
import type { AgentAwakeApi, AgentStatusApi, AgentTrustApi } from './api/agent-status-api'
import type {
  ClaudeUsageApi,
  CodexUsageApi,
  OpenCodeUsageApi,
  RateLimitsApi
} from './api/agent-usage-api'
import type { AiVaultApi } from './api/ai-vault-api'
import type { AppApi, E2EApi, PlatformApi } from './api/app-api'
import type { AutomationsApi } from './api/automation-api'
import type { BrowserApi } from './api/browser-api'
import type { CliApi } from './api/cli-install-api'
import type { CrashReportsApi, FeedbackApi } from './api/crash-report-api'
import type { DashboardApi, TerminalPreviewApi } from './api/dashboard-api'
import type { EmulatorApi } from './api/emulator-api'
import type { EphemeralVmApi } from './api/ephemeral-vm-api'
import type { ExportApi, FilesystemApi } from './api/filesystem-api'
import type { GitInspectionApi } from './api/git-inspection-api'
import type { GitOperationApi } from './api/git-operation-api'
import type { GithubPullRequestApi } from './api/github-pull-request-api'
import type { GithubWorkItemApi } from './api/github-work-item-api'
import type { GitLabApi } from './api/gitlab-api'
import type { BitbucketApi, HostedReviewApi } from './api/hosted-review-api'
import type { JiraApi } from './api/jira-api'
import type { LinearApi } from './api/linear-api'
import type { MobileApi } from './api/mobile-api'
import type { NativeChatApi } from './api/native-chat-api'
import type { OnboardingApi, StarNagApi } from './api/onboarding-api'
import type { OrcaProfileApi } from './api/orca-profile-api'
import type {
  ComputerUsePermissionsApi,
  DeveloperPermissionsApi,
  MacosTccPromptsApi,
  NotificationsApi
} from './api/os-permission-api'
import type { PetApi } from './api/pet-api'
import type { PluginsApi } from './api/plugin-host-api'
import type { PreflightApi } from './api/preflight-api'
import type { PtyApi } from './api/pty-api'
import type { ProjectGroupsApi, ProjectsApi, RepositoryApi } from './api/repository-api'
import type { RuntimeApi } from './api/runtime-api'
import type { KeybindingsApi, SettingsApi } from './api/settings-api'
import type { ShellApi } from './api/shell-api'
import type { SpeechApi } from './api/speech-api'
import type { SshApi } from './api/ssh-api'
import type { DiagnosticsApi, MemoryApi, StatsApi, TelemetryApi } from './api/telemetry-api'
import type { UiCommandEventApi } from './api/ui-command-event-api'
import type { UiWindowApi } from './api/ui-window-api'
import type { UpdaterApi } from './api/updater-api'
import type { WorkspaceCleanupApi, WorkspaceSpaceApi } from './api/workspace-cleanup-api'
import type { LocalhostWorktreeLabelsApi, WorkspacePortsApi } from './api/workspace-port-api'
import type { WorkspaceSessionApi } from './api/workspace-session-api'
import type { FolderWorkspacesApi, SparsePresetsApi, WorktreeApi } from './api/worktree-api'

export type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathResult
} from '../shared/shell-open-types'

type RuntimeEnvironmentSubscriptionHandle = {
  unsubscribe: () => void
  sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => void
}
import type {
  RuntimeMobileMarkdownRequest,
  RuntimeMobileMarkdownResponse
} from '../shared/mobile-markdown-document'
import type {
  DeveloperPermissionId,
  DeveloperPermissionRequestResult,
  DeveloperPermissionState,
  LocalNetworkConnectionTestResult
} from '../shared/developer-permissions-types'
import type {
  ComputerUsePermissionId,
  ComputerUsePermissionResetResult,
  ComputerUsePermissionSetupResult,
  ComputerUsePermissionStatusResult
} from '../shared/computer-use-permissions-types'
import type { ClaudeUsageBreakdownKind, ClaudeUsageSnapshot } from '../shared/claude-usage-types'
import type {
  CodexRateLimitResetResult,
  GrokAccountStatus,
  RateLimitRuntimeTarget,
  RateLimitState
} from '../shared/rate-limit-types'
import type {
  SpeechErrorEvent,
  SpeechLifecycleEvent,
  SpeechModelManifest,
  SpeechModelState,
  SpeechTranscriptEvent
} from '../shared/speech-types'
import type {
  WorkspaceSpaceAnalyzeResult,
  WorkspaceSpaceScanProgress
} from '../shared/workspace-space-types'
import type {
  WorkspacePortAdvertisedUrlChangedEvent,
  WorkspacePortKillRequest,
  WorkspacePortKillResult,
  WorkspacePortScanRequest,
  WorkspacePortScanResult
} from '../shared/workspace-ports'
import type { GhAuthDiagnostic } from '../shared/github-auth-types'
import type { CodexUsageBreakdownKind, CodexUsageSnapshot } from '../shared/codex-usage-types'
import type {
  OpenCodeUsageBreakdownKind,
  OpenCodeUsageSnapshot
} from '../shared/opencode-usage-types'
import type {
  AiVaultDeleteSessionArgs,
  AiVaultDeleteSessionResult
} from '../shared/ai-vault-session-deletion'
import type {
  AiVaultFirstUserPromptArgs,
  AiVaultFirstUserPromptResult,
  AiVaultListArgs,
  AiVaultListResult,
  AiVaultSubagentListArgs,
  AiVaultSubagentListResult
} from '../shared/ai-vault-types'
import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../shared/ai-vault-session-title'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../shared/ai-vault-resume-preparation'
import type { AgentType, NativeChatMessage } from '../shared/native-chat-types'
import type { NativeChatCompanionFrameFields } from '../shared/fork-native-chat-session-options/native-chat-transcript-companion'
import type { TelemetryConsentState } from '../shared/telemetry-consent-types'
import type { AgentKind, LaunchSource, RequestKind } from '../shared/telemetry-events'
import type { AppStarSource } from '../shared/gh-star-source'
import type {
  RemoteWorkspaceChangedEvent,
  RemoteWorkspaceConnectedClient,
  RemoteWorkspacePatchResult,
  RemoteWorkspaceSnapshot
} from '../shared/remote-workspace-types'
import type {
  Automation,
  AutomationCreateInput,
  AutomationDispatchRequest,
  AutomationDispatchResult,
  ExternalAutomationCreateInput,
  ExternalAutomationActionInput,
  ExternalAutomationManager,
  ExternalAutomationRunsInput,
  ExternalAutomationRunsPage,
  ExternalAutomationUpdateInput,
  AutomationRun,
  AutomationPrecheckResult,
  AutomationUpdateInput
} from '../shared/automations-types'
import type {
  WorkspaceCleanupDismissArgs,
  WorkspaceCleanupLocalProcessArgs,
  WorkspaceCleanupLocalProcessResult,
  WorkspaceCleanupScanArgs,
  WorkspaceCleanupScanProgress,
  WorkspaceCleanupScanResult
} from '../shared/workspace-cleanup'
import type { KeybindingActionId, KeybindingFileSnapshot } from '../shared/keybindings'

type GitLabRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

type GitHubRepoSelectorArgs = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
}

export type BrowserApi = {
  registerGuest: (args: {
    browserPageId: string
    workspaceId: string
    worktreeId: string
    sessionProfileId?: string | null
    webContentsId: number
  }) => Promise<boolean>
  isGuestRegistered: (args: { browserPageId: string; webContentsId: number }) => Promise<boolean>
  repairGuestRegistration: (args: {
    browserPageId: string
    workspaceId: string
    worktreeId: string
    sessionProfileId?: string | null
    webContentsId: number
  }) => Promise<boolean>
  unregisterGuest: (args: { browserPageId: string }) => Promise<void>
  openDevTools: (args: { browserPageId: string }) => Promise<boolean>
  setViewportOverride: (args: {
    browserPageId: string
    override: BrowserViewportOverride | null
  }) => Promise<boolean>
  setAnnotationViewportBridge: (args: BrowserSetAnnotationViewportBridgeArgs) => Promise<boolean>
  onGuestLoadFailed: (
    callback: (args: { browserPageId: string; loadError: BrowserLoadError }) => void
  ) => () => void
  onCertificateFailureChanged: (
    callback: (event: { browserPageId: string; failure: BrowserCertificateFailure | null }) => void
  ) => () => void
  proceedCertificate: (args: {
    browserPageId: string
    challengeId: string
  }) => Promise<BrowserCertificateProceedResult>
  onPermissionDenied: (callback: (event: BrowserPermissionDeniedEvent) => void) => () => void
  onPopup: (callback: (event: BrowserPopupEvent) => void) => () => void
  onDownloadRequested: (callback: (event: BrowserDownloadRequestedEvent) => void) => () => void
  onDownloadProgress: (callback: (event: BrowserDownloadProgressEvent) => void) => () => void
  onDownloadFinished: (callback: (event: BrowserDownloadFinishedEvent) => void) => () => void
  onContextMenuRequested: (
    callback: (event: BrowserContextMenuRequestedEvent) => void
  ) => () => void
  onContextMenuDismissed: (
    callback: (event: BrowserContextMenuDismissedEvent) => void
  ) => () => void
  onNavigationUpdate: (
    callback: (event: { browserPageId: string; url: string; title: string }) => void
  ) => () => void
  onActivateView: (
    callback: (data: { worktreeId?: string; browserPageId?: string }) => void
  ) => () => void
  onPaneFocus: (
    callback: (data: { worktreeId: string | null; browserPageId: string }) => void
  ) => () => void
  onOpenLinkInOrcaTab: (
    callback: (event: { browserPageId: string; url: string }) => void
  ) => () => void
  cancelDownload: (args: { downloadId: string }) => Promise<boolean>
  setGrabMode: (args: BrowserSetGrabModeArgs) => Promise<BrowserSetGrabModeResult>
  awaitGrabSelection: (args: BrowserAwaitGrabSelectionArgs) => Promise<BrowserGrabResult>
  cancelGrab: (args: BrowserCancelGrabArgs) => Promise<boolean>
  captureSelectionScreenshot: (
    args: BrowserCaptureSelectionScreenshotArgs
  ) => Promise<BrowserCaptureSelectionScreenshotResult>
  extractHoverPayload: (args: BrowserExtractHoverArgs) => Promise<BrowserExtractHoverResult>
  onGrabModeToggle: (callback: (browserPageId: string) => void) => () => void
  onGrabActionShortcut: (
    callback: (args: { browserPageId: string; key: 'c' | 's' }) => void
  ) => () => void
  sessionListProfiles: () => Promise<BrowserSessionProfile[]>
  sessionCreateProfile: (
    args: {
      scope: BrowserSessionProfileScope
      label: string
    } & BrowserSessionProfileCreateOptions
  ) => Promise<BrowserSessionProfile | null>
  sessionDeleteProfile: (args: { profileId: string }) => Promise<boolean>
  sessionImportCookies: (args: { profileId: string }) => Promise<BrowserCookieImportResult>
  sessionResolvePartition: (args: { profileId: string | null }) => Promise<string | null>
  sessionDetectBrowsers: () => Promise<DetectedBrowserInfo[]>
  sessionImportFromBrowser: (args: {
    profileId: string
    browserFamily: string
    browserProfile?: string
  }) => Promise<BrowserCookieImportResult>
  sessionClearDefaultCookies: () => Promise<boolean>
  notifyActiveTabChanged: (args: { browserPageId: string }) => Promise<boolean>
}

export type EmulatorApi = {
  onPaneFocus: (callback: (data: { worktreeId: string }) => void) => () => void
  onAutoAttach: (
    callback: (data: {
      worktreeId: string
      info: { deviceUdid: string; streamUrl: string; wsUrl: string; axUrl?: string }
    }) => void
  ) => () => void
  startFrameStream: (args: { streamUrl: string; streamKey?: string }) => Promise<{
    streamId: string
  }>
  stopFrameStream: (args: { streamId: string }) => Promise<void>
  onFrameStreamFrame: (
    callback: (data: { streamId: string; bytes: ArrayBuffer }) => void
  ) => () => void
  onFrameStreamError: (
    callback: (data: { streamId: string; message: string }) => void
  ) => () => void
  startVideoStream: (args: { deviceId: string; streamId: string }) => Promise<{ streamId: string }>
  stopVideoStream: (args: { streamId: string }) => Promise<void>
  onVideoStreamMeta: (
    callback: (data: {
      streamId: string
      deviceId: string
      meta: { codecId: string; width: number; height: number }
    }) => void
  ) => () => void
  onVideoStreamFrame: (
    callback: (data: {
      streamId: string
      deviceId: string
      config: boolean
      keyFrame: boolean
      bytes: ArrayBuffer
    }) => void
  ) => () => void
}

export type DetectedBrowserProfileInfo = {
  name: string
  directory: string
}

export type DetectedBrowserInfo = {
  family: BrowserSessionProfileSource['browserFamily']
  label: string
  profiles: DetectedBrowserProfileInfo[]
  selectedProfile: string
}

export type PreflightStatus = {
  git: { installed: boolean }
  gh: { installed: boolean; authenticated: boolean }
  /** Optional — older preload payloads predating GitLab support omit it; consumers gate on `glab?.installed`. */
  glab?: { installed: boolean; authenticated: boolean }
  bitbucket?: { configured: boolean; authenticated: boolean; account: string | null }
  azureDevOps?: {
    configured: boolean
    authenticated: boolean
    account: string | null
    baseUrl: string | null
    tokenConfigured: boolean
  }
  gitea?: {
    configured: boolean
    authenticated: boolean
    account: string | null
    baseUrl: string | null
    tokenConfigured: boolean
  }
}

export type RefreshAgentsResult = {
  agents: string[]
  addedPathSegments: string[]
  shellHydrationOk: boolean
  /** Drives agent_picks `on_path:false` triage (dashboard 1562016). `'shell_hydrate'` = detection saw the user's
   *  full shell PATH; `'sync_seed_only'` = hydration failed and detection ran against the `patchPackagedProcessPath` seed list. */
  pathSource: PathSource
  /** Classified hydration outcome: `'none'` on success, else a failure mode when `shellHydrationOk` is false. */
  pathFailureReason: ShellHydrationFailureReason
}

export type PreflightRuntimeContext = {
  wslDistro?: string | null
  wslDefault?: boolean
  projectRuntime?: ProjectExecutionRuntimeResolution
}

export type PreflightApi = {
  check: (args?: PreflightRuntimeContext & { force?: boolean }) => Promise<PreflightStatus>
  detectAgents: (args?: PreflightRuntimeContext) => Promise<string[]>
  refreshAgents: (args?: PreflightRuntimeContext) => Promise<RefreshAgentsResult>
  detectRemoteAgents: (args: { connectionId: string }) => Promise<string[]>
  detectRemoteWindowsTerminalCapabilities: (args: { connectionId: string }) => Promise<{
    wslAvailable: boolean
    wslDistros: string[]
    pwshAvailable: boolean
    gitBashAvailable: boolean
    hostPlatform: NodeJS.Platform | null
  }>
}

// Mirror of daemon's `DaemonSessionInfo` (src/main/daemon/types.ts); not imported — preload can't depend on main-only protocol types.
export type PtyManagementSession = {
  sessionId: string
  state: 'created' | 'spawning' | 'running' | 'exiting' | 'exited'
  shellState: 'pending' | 'ready' | 'timed_out' | 'unsupported'
  isAlive: boolean
  pid: number | null
  cwd: string | null
  cols: number
  rows: number
  createdAt: number
  protocolVersion: number
}

// 'severed': macOS can no longer attribute daemon terminals to Orca, so Accessibility/
// Automation grants silently stop applying until the daemon is restarted (STA-3491).
export type PtyManagementMacTccAttributionHealth = 'intact' | 'severed' | 'unknown'

export type PtyManagementApi = {
  // `degraded`: daemon is alive but can't spawn fresh PTYs, so new terminals run locally without daemon persistence.
  listSessions: () => Promise<{ sessions: PtyManagementSession[]; degraded: boolean }>
  killAll: () => Promise<{
    killedCount: number
    remainingCount: number
    killedSessionIds?: string[]
  }>
  killOne: (args: { sessionId: string }) => Promise<{ success: boolean }>
  restart: () => Promise<{ success: boolean }>
  macTccAttribution: () => Promise<{ health: PtyManagementMacTccAttributionHealth }>
}

export type ExportApi = {
  htmlToPdf: (args: {
    html: string
    title: string
  }) => Promise<
    { success: true; filePath: string } | { success: false; cancelled?: boolean; error?: string }
  >
}

export type StatsApi = {
  getSummary: () => Promise<StatsSummary>
}

// Diagnostics IPC payloads; mirror the runtime types in `src/main/observability/{index,bundle}.ts`.
export type DiagnosticsStatusPayload = {
  readonly localFileEnabled: boolean
  readonly bundleEnabled: boolean
  readonly traceFilePath: string
  readonly traceFamilySize: number
  readonly disabledReason?:
    | 'do_not_track'
    | 'orca_telemetry_disabled'
    | 'orca_diagnostics_disabled'
    | 'ci'
}
export type DiagnosticsBundlePayload = {
  readonly bundleSubmissionId: string
  readonly bytes: number
  readonly spanCount: number
}
export type DiagnosticsUploadPayload =
  | {
      readonly ticketId: string
    }
  | {
      readonly canceled: true
    }

export type MemoryApi = {
  getSnapshot: () => Promise<MemorySnapshot>
}

type UsageProviderSnapshot = {
  scanState: unknown
  summary: { scope: string; range: string }
  daily: unknown[]
  modelBreakdown: unknown[]
  recentSessions: unknown[]
}

type UsageQueryArgs<Snapshot extends UsageProviderSnapshot> = Pick<
  Snapshot['summary'],
  'scope' | 'range'
>

type UsageProviderApi<Snapshot extends UsageProviderSnapshot, BreakdownKind> = {
  getScanState: () => Promise<Snapshot['scanState']>
  setEnabled: (args: { enabled: boolean }) => Promise<Snapshot['scanState']>
  refresh: (args?: { force?: boolean }) => Promise<Snapshot['scanState']>
  getSnapshot: (args: UsageQueryArgs<Snapshot> & { limit?: number }) => Promise<Snapshot>
  getSummary: (args: UsageQueryArgs<Snapshot>) => Promise<Snapshot['summary']>
  getDaily: (args: UsageQueryArgs<Snapshot>) => Promise<Snapshot['daily']>
  getBreakdown: (
    args: UsageQueryArgs<Snapshot> & { kind: BreakdownKind }
  ) => Promise<Snapshot['modelBreakdown']>
  getRecentSessions: (
    args: UsageQueryArgs<Snapshot> & { limit?: number }
  ) => Promise<Snapshot['recentSessions']>
}

export type ClaudeUsageApi = UsageProviderApi<ClaudeUsageSnapshot, ClaudeUsageBreakdownKind>

export type CodexUsageApi = UsageProviderApi<CodexUsageSnapshot, CodexUsageBreakdownKind>

export type OpenCodeUsageApi = UsageProviderApi<OpenCodeUsageSnapshot, OpenCodeUsageBreakdownKind>

export type AiVaultApi = {
  listSessions: (args?: AiVaultListArgs) => Promise<AiVaultListResult>
  resolveSessionTitles: (args: AiVaultSessionTitlesArgs) => Promise<AiVaultSessionTitlesResult>
  cancelListSessions: (args: { requestToken: string }) => Promise<void>
  prepareSessionResume: (
    args: AiVaultPrepareSessionResumeArgs
  ) => Promise<AiVaultPrepareSessionResumeResult>
  /** Lists the Task subagent transcripts of one session, on demand. */
  listSubagentSessions: (args: AiVaultSubagentListArgs) => Promise<AiVaultSubagentListResult>
  /** Full first user prompt for copy/reuse (re-parses one transcript). */
  getFirstUserPrompt: (args: AiVaultFirstUserPromptArgs) => Promise<AiVaultFirstUserPromptResult>
  /** Moves a deletable session's transcript to the OS trash; local sessions only. */
  deleteSession: (args: AiVaultDeleteSessionArgs) => Promise<AiVaultDeleteSessionResult>
  /** Fires when any app window regains OS focus; returns an unsubscribe. */
  onWindowFocused: (callback: () => void) => () => void
}

// notFound marks a not-yet-on-disk miss (retry-worthy) vs a real read/parse error (#8401).
export type NativeChatReadSessionResult =
  | (NativeChatCompanionFrameFields & {
      messages: NativeChatMessage[]
      /** Authoritative "older history exists". Optional: a runtime old enough to
       *  omit it leaves the caller inferring from the returned count, which is
       *  wrong whenever a read is bounded by bytes rather than turns. */
      hasMore?: boolean
      /** Byte offset of the oldest returned turn — pass it back as
       *  `beforeOffset` to read the page immediately older. Optional for the
       *  same old-runtime reason as `hasMore`; without it the caller can only
       *  page by growing `limit`. */
      beforeOffset?: number
    })
  | { error: string; notFound?: true }

/** Messages appended to a live-tailed transcript since the previous emit. */
export type NativeChatAppendedMessages = NativeChatMessage[]

export type NativeChatSubscriptionFrame = NativeChatCompanionFrameFields &
  (
    | {
        type: 'snapshot'
        messages: NativeChatMessage[]
        hasMore: boolean
        /** Oldest returned turn's byte offset; seeds pagination from a live
         *  snapshot, which otherwise supersedes the seed read that carried it. */
        beforeOffset?: number
        error?: string
      }
    | {
        type: 'replacement'
        messages: NativeChatMessage[]
        hasMore: boolean
        beforeOffset?: number
      }
    | { type: 'appended'; messages: NativeChatMessage[] }
  )

/** Wire payload for the `nativeChat:appended` push channel. */
export type NativeChatAppendedPayload = {
  subscriptionId: string
  frame: NativeChatSubscriptionFrame
}

export type NativeChatSubscribeArgs = {
  /** Unique per-caller id, echoed on every append so multiple live panes in
   *  one renderer don't cross-talk. */
  subscriptionId: string
  agent: AgentType
  sessionId: string
  /** Authoritative transcript path from the agent hook (providerSession). */
  transcriptPath?: string
  /** First snapshot size; later readSession calls grow this for pagination. */
  limit?: number
  /** Plain-`ssh:` owner of the pane, when it has one — the watcher then lives on
   *  that host's relay and main forwards its frames. */
  sshConnectionId?: string
}

export type NativeChatReadSessionArgs = {
  agent: AgentType
  sessionId: string
  /** How many of the most-recent turns to return. */
  limit?: number
  /** Authoritative transcript path from the agent hook (providerSession). */
  transcriptPath?: string
  /** Plain-`ssh:` owner of the pane, when it has one — the read then runs on
   *  that host's relay, since this process cannot see its disk. */
  sshConnectionId?: string
  /** Read the window ending at this byte offset instead of the file's tail —
   *  a prior result's `beforeOffset`, which pages older history. */
  beforeOffset?: number
}

export type NativeChatApi = {
  /** Read the on-disk transcript for an agent + session id, windowed to the most recent `limit`
   *  turns. `transcriptPath` is the hook-reported authoritative path, preferred over the id glob. */
  readSession: (
    agent: AgentType,
    sessionId: string,
    limit?: number,
    transcriptPath?: string
  ) => Promise<NativeChatReadSessionResult>
  /** Live-tail a transcript. The first frame is a bounded race-safe snapshot;
   *  later frames contain only newly appended messages. */
  subscribe: (
    args: NativeChatSubscribeArgs,
    onFrame: (frame: NativeChatSubscriptionFrame) => void
  ) => () => void
}

export type AppApi = {
  /** Returns the app identity currently exposed to native chrome and the titlebar. */
  getIdentity: () => Promise<AppIdentity>
  /** Returns a URL base for feature-wall assets. In dev this is Vite /@fs;
   *  in packaged builds this is file:// resources. Renderer appends filenames. */
  getFeatureWallAssetBaseUrl: () => Promise<string>
  /** Relaunches the app (app.relaunch() + app.exit(0)) for settings that need a full restart to apply. */
  relaunch: () => Promise<void>
  /** Restarts Orca through the normal quit pipeline so daemon-backed terminal
   *  sessions survive and can reattach after the new process starts. */
  restart: () => Promise<void>
  /** Reloads the current app renderer through main so expected renderer
   *  teardown can be classified before Electron emits process-gone events. */
  reload: () => Promise<void>
  /** Stages the renderer's final state synchronously before unload. */
  stageBeforeUnloadSync: (args: {
    sessions: { state: WorkspaceSessionState; hostId?: ExecutionHostId }[]
    ui: Partial<PersistedUIState>
  }) => void
  /** Resolves once the last staged checkpoint is durably written; rejects if that
   *  write failed, so a reload/restart can abort instead of losing the snapshot. */
  awaitBeforeUnloadCheckpoint: () => Promise<void>
  /** Resolves when the daemon PTY provider and hook receiver have either
   *  started or failed open for the first BrowserWindow. */
  awaitFirstWindowStartupServices: () => Promise<void>
  /** Reconciles legacy worker authority around persisted terminal reconnect. */
  recoverLegacyWorkerTerminalsForRendererStartup: () => Promise<void>
  /** Emits a startup benchmark marker when ORCA_STARTUP_DIAGNOSTICS is enabled. */
  startupDiagnostic: (event: string, details?: Record<string, unknown>) => Promise<void>
  /** macOS active input mode, or layout ID when no IME is selected (e.g. `com.apple.keylayout.PolishPro`).
   *  Distinguishes CJK IMEs and Option-layer-composing layouts that look like US QWERTY (issue #1205).
   *  Returns null on non-Darwin or when the defaults read fails. */
  getKeyboardInputSourceId: () => Promise<string | null>
  /** Updates the macOS Dock unread badge. No-op on Windows/Linux. */
  setUnreadDockBadgeCount: (count: number) => Promise<void>
  /** Resolves the launch directory for global Floating Terminal tabs. */
  getFloatingTerminalCwd: (args?: FloatingTerminalCwdRequest) => Promise<string>
  /** Resolves Orca's app-owned directory for auto-created Floating Workspace
   *  markdown notes. */
  getFloatingMarkdownDirectory: () => Promise<string>
  /** Opens a native picker for markdown documents, rooted in the floating
   *  workspace, and authorizes the selected file for editor reads/writes. */
  pickFloatingMarkdownDocument: () => Promise<MarkdownDocument | null>
  /** Opens a native directory picker and authorizes the selected directory
   *  for Floating Workspace markdown file creation. */
  pickFloatingWorkspaceDirectory: () => Promise<string | null>
  /** Persists flag-gated terminal render evidence under app-owned userData. */
  writeTerminalRenderDesyncEvidence: (
    args: WriteTerminalRenderDesyncEvidenceArgs
  ) => Promise<WriteTerminalRenderDesyncEvidenceResult>
}

/** Panel contribution as surfaced by the main-process plugin service. */
export type PluginHostPanel = {
  id: string
  title: string
  /** Lucide icon name declared in the plugin manifest. */
  icon?: string
  tabKey: `plugin:${string}`
}

/** `pending` = awaiting (re-)consent; `idle` = enabled, worker not running
 *  (lazy); `restarting` = waiting for supervised backoff; `errored` = crashed past the restart budget or failed to start;
 *  `invalid` = unreadable manifest. */
export type PluginHostStatus =
  | 'running'
  | 'restarting'
  | 'idle'
  | 'pending'
  | 'disabled'
  | 'errored'
  | 'invalid'

/** Wire shape of plugins:list — must stay assignable from the main-process
 *  projection in src/main/plugins/plugin-list-projection.ts. */
export type PluginHostListEntry = {
  pluginKey: string
  consentFingerprint: string | null
  name: string
  version: string
  publisher: string
  description?: string
  status: PluginHostStatus
  needsReconsent: boolean
  error?: string
  isDev: boolean
  official: boolean
  bundled: boolean
  capabilities: { kind: string; description: string }[]
  panels: PluginHostPanel[]
  commands: {
    id: string
    title: string
    context: 'global' | 'worktree'
    handler: { type: 'built-in'; action: string } | { type: 'worker' }
    keybindings: { key: string; when: 'global' | 'worktree' }[]
  }[]
  hasWorker: boolean
  vmRecipes?: {
    id: string
    name: string
    description?: string
    commands: {
      phase: 'create' | 'suspend' | 'resume' | 'destroy'
      command: string
    }[]
  }[]
  restarts: number
  blockedByKillList?: { reason: string; advisoryUrl?: string }
  source?: {
    kind: 'local-path' | 'git' | 'marketplace' | 'bundled'
    reference: string
    resolvedCommit: string | null
    contentHash: string
    marketplace?: { reference: string; resolvedCommit: string }
  }
}

export type PluginHostLogLine = { ts: number; level: 'info' | 'warn' | 'error'; line: string }

export type PluginHostInstallSource =
  | { kind: 'local-path'; path: string }
  | { kind: 'git'; url: string; ref: string }

export type PluginHostInstallResult =
  | {
      ok: true
      pluginKey: string
      version: string
      contentHash: string
      consentFingerprint: string
      resolvedCommit: string | null
    }
  | { ok: false; error: string }

export type PluginMarketplaceHostSourceState = {
  id: string
  source: PluginMarketplaceGitSource
  addedAt: number
  marketplace: {
    name: string
    owner: string
    resolvedCommit: string
    fetchedAt: number
  } | null
  stale: boolean
  official: boolean
  error?: string
}

export type PluginMarketplaceHostListing = {
  marketplaceSourceId: string
  marketplaceName: string
  marketplaceOwner: string
  marketplaceCommit: string
  pluginKey: string
  source: PluginMarketplaceGitSource
  description?: string
  categories: string[]
  official: boolean
  bundled: boolean
  blockedByKillList?: { reason: string; advisoryUrl?: string }
}

export type PluginMarketplaceHostInstallPreview = {
  marketplaceSourceId: string
  marketplaceName: string
  marketplaceOwner: string
  marketplaceCommit: string
  pluginKey: string
  source: PluginMarketplaceGitSource
  resolvedCommit: string
  contentHash: string
  consentFingerprint: string
  manifest: PluginManifest
  official: boolean
  bundled: boolean
  blockedByKillList?: { reason: string; advisoryUrl?: string }
}

export type PreloadApi = {
  app: AppApi
  orcaProfiles: {
    list: () => Promise<OrcaProfileListResult>
    authStatus: () => Promise<OrcaProfileAuthStatus>
    createLocal: (args?: CreateLocalOrcaProfileArgs) => Promise<CreateLocalOrcaProfileResult>
    createCloudLinked: (
      args?: CreateCloudLinkedOrcaProfileArgs
    ) => Promise<CreateCloudLinkedOrcaProfileResult>
    switchProfile: (args: SwitchOrcaProfileArgs) => Promise<SwitchOrcaProfileResult>
    transferProject: (
      args: TransferOrcaProfileProjectArgs
    ) => Promise<TransferOrcaProfileProjectResult>
    findProjectProfiles: (
      args: FindOrcaProfileProjectsByPathArgs
    ) => Promise<FindOrcaProfileProjectsByPathResult>
    connectCurrent: () => Promise<ConnectCurrentOrcaProfileResult>
    refreshAuth: () => Promise<RefreshCurrentOrcaProfileAuthResult>
    signOutCurrent: () => Promise<SignOutCurrentOrcaProfileResult>
    selectOrg: (args: SelectOrcaProfileOrgArgs) => Promise<SelectOrcaProfileOrgResult>
    orgMembersList: (
      args: OrcaProfileOrgMembersListArgs
    ) => Promise<OrcaProfileOrgMembersListResult>
    orgMemberInvite: (
      args: OrcaProfileOrgMemberInviteArgs
    ) => Promise<OrcaProfileOrgMemberMutationResult>
    orgInviteRevoke: (
      args: OrcaProfileOrgInviteRevokeArgs
    ) => Promise<OrcaProfileOrgMemberMutationResult>
    orgMemberChangeRole: (
      args: OrcaProfileOrgMemberChangeRoleArgs
    ) => Promise<OrcaProfileOrgMemberMutationResult>
    orgMemberRemove: (
      args: OrcaProfileOrgMemberRemoveArgs
    ) => Promise<OrcaProfileOrgMemberMutationResult>
  }
  platform: {
    get: () => {
      platform: NodeJS.Platform
      osRelease: string
      arch: string
      /** Login shell or ComSpec when available. */
      shell: string
      displayServer: 'wayland' | 'x11' | null
    }
  }
  e2e: {
    getConfig: () => E2EConfig
  }
  repos: {
    list: () => Promise<Repo[]>
    listForExecutionHost?: (args: ListReposForExecutionHostArgs) => Promise<HostRepoCatalogSnapshot>
    // Why: error union matches the IPC handler's return shape; renderer callers branch on `'error' in result`.
    add: (args: {
      path: string
      kind?: 'git' | 'folder'
    }) => Promise<{ repo: Repo } | { error: string }>
    remove: (args: { repoId: string }) => Promise<void>
    // Forget a project on one execution host only, leaving the same repo id on other hosts intact.
    removeForHost: (args: { repoId: string; hostId: string }) => Promise<void>
    reorder: (args: { orderedIds: string[] }) => Promise<{ status: 'applied' | 'rejected' }>
    reorderForHost: (args: {
      orderedIds: string[]
      hostId: string
    }) => Promise<{ status: 'applied' | 'rejected' }>
    update: (args: {
      repoId: string
      hostId?: ExecutionHostId
      updates: Partial<
        Pick<
          Repo,
          | 'displayName'
          | 'badgeColor'
          | 'repoIcon'
          | 'upstream'
          | 'hookSettings'
          | 'worktreeBaseRef'
          | 'worktreeBasePath'
          | 'kind'
          | 'issueSourcePreference'
          | 'externalWorktreeVisibility'
          | 'externalWorktreeVisibilityPromptDismissedAt'
          | 'externalWorktreeInboxBaselinePaths'
          | 'importedExternalWorktreePaths'
          | 'agentWorktreeVisibility'
          | 'projectGroupId'
          | 'projectGroupOrder'
          | 'forkSyncMode'
        >
      > & {
        sourceControlAi?: Repo['sourceControlAi'] | null
        externalWorktreeDiscoverySuppressedAt?: Repo['externalWorktreeDiscoverySuppressedAt'] | null
      }
    }) => Promise<Repo>
    pickFolder: () => Promise<string | null>
    pickFolders: () => Promise<string[]>
    pickDirectory: () => Promise<string | null>
    clone: (args: { url: string; destination: string }) => Promise<Repo>
    cloneRemote: (args: { connectionId: string; url: string; destination: string }) => Promise<Repo>
    createRemote: (args: {
      connectionId: string
      parentPath: string
      name: string
      kind: 'git' | 'folder'
    }) => Promise<{ repo: Repo } | { error: string }>
    cloneAbort: () => Promise<void>
    // Why: error union matches the IPC handler's return shape; renderer callers branch on `'error' in result`.
    addRemote: (args: {
      connectionId: string
      remotePath: string
      displayName?: string
      kind?: 'git' | 'folder'
    }) => Promise<{ repo: Repo } | { error: string }>
    // Why: error union matches the IPC handler's return shape; renderer callers branch on `'error' in result`.
    create: (args: {
      parentPath: string
      name: string
      kind: 'git' | 'folder'
    }) => Promise<{ repo: Repo } | { error: string }>
    isGitAvailable: () => Promise<boolean>
    getDefaultCreateProjectParent: () => Promise<string>
    onCloneProgress: (callback: (data: { phase: string; percent: number }) => void) => () => void
    getGitUsername: (args: { repoId: string }) => Promise<string>
    getBaseRefDefault: (args: {
      repoId: string
      hostId?: ExecutionHostId
    }) => Promise<BaseRefDefaultResult>
    searchBaseRefs: (args: {
      repoId: string
      query: string
      limit?: number
      hostId?: ExecutionHostId
    }) => Promise<string[]>
    searchBaseRefDetails: (args: {
      repoId: string
      query: string
      limit?: number
      hostId?: ExecutionHostId
    }) => Promise<BaseRefSearchResult[]>
    onChanged: (callback: () => void) => () => void
  }
  projects: {
    list: () => Promise<Project[]>
    update: (args: ProjectUpdateArgs) => Promise<Project | null>
    listHostSetups: () => Promise<ProjectHostSetup[]>
    createHostSetup: (args: ProjectHostSetupCreateArgs) => Promise<ProjectHostSetupCreateResult>
    setupExistingFolder: (
      args: ProjectHostSetupExistingFolderArgs
    ) => Promise<ProjectHostSetupResult>
    updateHostSetup: (args: ProjectHostSetupUpdateArgs) => Promise<ProjectHostSetupUpdateResult>
    deleteHostSetup: (args: ProjectHostSetupDeleteArgs) => Promise<ProjectHostSetupDeleteResult>
  }
  projectGroups: {
    list: () => Promise<ProjectGroup[]>
    create: (args: {
      name: string
      parentPath?: string | null
      connectionId?: string | null
      parentGroupId?: string | null
      createdFrom?: ProjectGroup['createdFrom']
    }) => Promise<ProjectGroup>
    update: (args: {
      groupId: string
      updates: Partial<Pick<ProjectGroup, 'name' | 'isCollapsed' | 'tabOrder' | 'color'>>
    }) => Promise<ProjectGroup | null>
    delete: (args: { groupId: string }) => Promise<boolean>
    moveProject: (args: {
      projectId: string
      groupId: string | null
      order?: number
    }) => Promise<Repo | null>
    scanNested: (args: {
      path: string
      connectionId?: string
      scanId?: string
      options?: Record<string, unknown>
    }) => Promise<NestedRepoScanResult>
    cancelNestedScan: (args: { scanId: string }) => Promise<boolean>
    onNestedScanProgress: (
      callback: (data: { scanId: string; scan: NestedRepoScanResult }) => void
    ) => () => void
    importNested: (args: {
      parentPath: string
      groupName: string
      projectPaths: string[]
      connectionId?: string
      scanId?: string
      mode: ProjectGroupImportMode
    }) => Promise<ProjectGroupImportResult>
  }
  folderWorkspaces: {
    list: () => Promise<FolderWorkspace[]>
    getPathStatus: (args: FolderWorkspacePathStatusRequest) => Promise<FolderWorkspacePathStatus>
    create: (args: {
      projectGroupId: string
      name?: string
      folderPath?: string | null
      connectionId?: string | null
      linkedTask?: FolderWorkspace['linkedTask']
      createdWithAgent?: FolderWorkspace['createdWithAgent']
      pendingFirstAgentMessageRename?: boolean
    }) => Promise<FolderWorkspace>
    update: (args: {
      folderWorkspaceId: string
      updates: Partial<
        Pick<
          FolderWorkspace,
          | 'name'
          | 'folderPath'
          | 'linkedTask'
          | 'comment'
          | 'isArchived'
          | 'isUnread'
          | 'isPinned'
          | 'sortOrder'
          | 'manualOrder'
          | 'workspaceStatus'
          | 'createdWithAgent'
          | 'pendingFirstAgentMessageRename'
          | 'firstAgentMessageRenameError'
          | 'lastActivityAt'
          | 'diffComments'
        >
      >
    }) => Promise<FolderWorkspace | null>
    delete: (args: { folderWorkspaceId: string }) => Promise<boolean>
  }
  sparsePresets: {
    list: (args: { repoId: string }) => Promise<SparsePreset[]>
    save: (args: {
      repoId: string
      id?: string
      name: string
      directories: string[]
    }) => Promise<SparsePreset>
    remove: (args: { repoId: string; presetId: string }) => Promise<void>
    onChanged: (callback: (data: { repoId: string }) => void) => () => void
  }
  worktrees: {
    list: (args: { repoId: string }) => Promise<Worktree[]>
    listDetected: {
      (
        args: ListDetectedWorktreesArgs
      ): Promise<HostQualifiedDetectedWorktreeResult | DetectedWorktreeListResult>
      (args: LegacyDetectedWorktreeRequest): Promise<DetectedWorktreeListResult>
    }
    listKnownForExecutionHost?: (
      args: ListKnownWorktreesForExecutionHostArgs
    ) => Promise<HostQualifiedKnownWorktreeResult>
    /** Retires the persisted metadata an authoritative scan proved gone, so it stops feeding the read above. */
    forgetRemovedForExecutionHost?: (
      args: ForgetRemovedWorktreesForExecutionHostArgs
    ) => Promise<ForgetRemovedWorktreesForExecutionHostResult>
    cancelListDetected?: (args: { providerRequestId: ProviderRequestId }) => Promise<void>
    listAll: () => Promise<Worktree[]>
    create: (args: CreateWorktreeArgs) => Promise<CreateWorktreeResult>
    /** Two-phase progress for a background `create`, correlated by `creationId`. The remote/runtime
     *  create path emits nothing, so the surface falls back to an indeterminate spinner. */
    onCreateProgress: (
      callback: (data: { creationId?: string; phase: 'fetching' | 'creating' }) => void
    ) => () => void
    prefetchCreateBase: (args: { repoId: string; baseBranch?: string }) => Promise<void>
    resolvePrBase: (args: {
      repoId: string
      prNumber: number
      headRefName?: string
      baseRefName?: string
      isCrossRepository?: boolean
    }) => Promise<GitHubPrStartPoint | { error: string }>
    /** GitLab parallel of resolvePrBase. For same-project MRs returns
     *  `<remote>/<source_branch>`; for fork MRs fetches
     *  refs/merge-requests/<iid>/head and returns the SHA. */
    resolveMrBase: (args: {
      repoId: string
      mrIid: number
      sourceBranch?: string
      targetBranch?: string
      isCrossRepository?: boolean
    }) => Promise<
      | { baseBranch: string; compareBaseRef?: string; pushTarget?: GitPushTarget }
      | { error: string }
    >
    remove: (args: {
      worktreeId: string
      hostId?: ExecutionHostId
      force?: boolean
      // Why (#11960): distinct from `force`, which the plain Delete confirmation
      // already sets to skip the dirty-file prompt. Only an explicit Force Delete
      // may waive the proof that every PTY stopped.
      allowUnverifiedPtyStop?: boolean
      skipArchive?: boolean
    }) => Promise<RemoveWorktreeResult>
    // Forget a workspace from Orca only (no remote Git/FS work) — for workspaces pinned to a removed/disconnected SSH host.
    forgetLocal: (args: {
      worktreeId: string
      hostId?: ExecutionHostId
    }) => Promise<RemoveWorktreeResult>
    forceDeletePreservedBranch: (args: {
      worktreeId: string
      branchName: string
      expectedHead: string
      hostId?: ExecutionHostId
    }) => Promise<ForceDeleteWorktreeBranchResult>
    updateMeta: (args: { worktreeId: string; updates: Partial<WorktreeMeta> }) => Promise<Worktree>
    listLineage: () => Promise<{
      lineage: Record<string, WorktreeLineage>
      workspaceLineage?: Record<string, WorkspaceLineage>
    }>
    listLineageForHost?: (args: ListDesktopLineageForHostArgs) => Promise<HostLineageSnapshot>
    updateLineage: (args: {
      worktreeId: string
      parentWorktreeId?: string
      noParent?: boolean
    }) => Promise<WorktreeLineage | null>
    persistSortOrder: (args: { orderedIds: string[] }) => Promise<void>
    /** Full CLI output of the last branch auto-rename generation failure, held
     *  in main memory only — null after a restart or once the failure clears. */
    getBranchRenameFailureOutput: (args: { worktreeId: string }) => Promise<string | null>
    onChanged: (callback: (data: { repoId: string }) => void) => () => void
    onGitStatusMetadataChanged: (callback: (data: { repoId: string }) => void) => () => void
    onHeadIdentitiesChanged: (
      callback: (data: { repoId: string; identities: WorktreeHeadIdentity[] }) => void
    ) => () => void
    onBaseStatus: (callback: (data: WorktreeBaseStatusEvent) => void) => () => void
    onRemoteBranchConflict: (
      callback: (data: WorktreeRemoteBranchConflictEvent) => void
    ) => () => void
  }
  workspaceCleanup: {
    scan: (
      args?: WorkspaceCleanupScanArgs,
      onProgress?: (progress: WorkspaceCleanupScanProgress) => void
    ) => Promise<WorkspaceCleanupScanResult>
    dismiss: (args: WorkspaceCleanupDismissArgs) => Promise<void>
    clearDismissals: () => Promise<void>
    hasKillableLocalProcesses: (
      args: WorkspaceCleanupLocalProcessArgs
    ) => Promise<WorkspaceCleanupLocalProcessResult>
  }
  workspaceSpace: {
    analyze: () => Promise<WorkspaceSpaceAnalyzeResult>
    cancel: () => Promise<boolean>
    onProgress: (callback: (progress: WorkspaceSpaceScanProgress) => void) => () => void
  }
  workspacePorts: {
    scan: (args: WorkspacePortScanRequest) => Promise<WorkspacePortScanResult>
    kill: (args: WorkspacePortKillRequest) => Promise<WorkspacePortKillResult>
    onAdvertisedUrlChanged: (
      callback: (event: WorkspacePortAdvertisedUrlChangedEvent) => void
    ) => () => void
  }
  pty: {
    spawn: (opts: {
      cols: number
      rows: number
      cwd?: string
      cwdFallback?: 'worktree'
      env?: Record<string, string>
      envToDelete?: string[]
      command?: string
      commandDelivery?: 'renderer' | 'provider'
      launchConfig?: SleepingAgentLaunchConfig
      resumeProviderSession?: AgentProviderSessionMetadata
      launchToken?: string
      launchAgent?: TuiAgent
      startupCommandDelivery?: StartupCommandDelivery
      connectionId?: string | null
      worktreeId?: string
      sessionId?: string
      // Why: lets a single tab open in a different shell than the user's default.
      shellOverride?: string
      projectRuntime?: ProjectExecutionRuntimeResolution
      terminalColorQueryReplies?: { foreground?: string; background?: string }
      // Why: mark the PTY hidden before its first byte so the delivery gate owns spawn-time queries (terminal-query-authority.md §races).
      initiallyHidden?: boolean
      // Why: main sync-flushes the (worktreeId,tabId,leafId→ptyId) binding before pty:spawn returns to close a SIGKILL race (INVESTIGATION.md).
      tabId?: string
      leafId?: string
      // Why: main fires `agent_started` only on spawn success, so launch metadata rides this field (telemetry-plan.md §Agent launch semantics).
      telemetry?: { agent_kind: AgentKind; launch_source: LaunchSource; request_kind: RequestKind }
    }) => Promise<{
      id: string
      launchAgent?: TuiAgent
      launchConfig?: SleepingAgentLaunchConfig
      snapshot?: string
      snapshotCols?: number
      snapshotRows?: number
      snapshotPrefixAnsi?: string
      snapshotFrameAnsi?: string
      snapshotFrameRestoreAnsi?: string
      snapshotKittyKeyboardFlags?: number
      snapshotSeq?: number
      isReattach?: boolean
      isAlternateScreen?: boolean
      replay?: string
      sessionExpired?: boolean
      coldRestore?: { scrollback: string; cwd: string; cols?: number; rows?: number }
      startupCwdFallback?: { kind: 'worktree'; cwd: string }
      agentResumeUnavailable?: true
    }>
    write: (id: string, data: string) => void
    writeAccepted: (id: string, data: string) => Promise<boolean>
    writeInputAccepted: (id: string, data: string) => Promise<boolean>
    onWriteUnavailable?: (callback: (payload: { id: string }) => void) => () => void
    resize: (id: string, cols: number, rows: number) => void
    claimViewport: (id: string, cols: number, rows: number) => void
    reportGeometry: (id: string, cols: number, rows: number) => void
    signal: (id: string, signal: string) => void
    clearBuffer: (id: string) => void
    kill: (id: string, opts?: { keepHistory?: boolean }) => Promise<void>
    ackColdRestore: (id: string) => void
    ackData: (id: string, charCount: number, processedChars?: number) => void
    onDeliveryResyncRequest: (callback: (payload: { requestId: number }) => void) => () => void
    respondDeliveryResync: (payload: {
      requestId: number
      processedCharsByPty: Record<string, number>
    }) => void
    /** Renderer-initiated delivery health/heal lane over invoke — reaches main
     *  even when every main→renderer push channel is dead (field wedge). */
    reportRendererDeliveryState: (
      report: PtyRendererDeliveryStateReport
    ) => Promise<PtyRendererDeliveryHealthReply>
    /** Live pty:data listener count on the preload emitter (sync) — heal-time
     *  discriminator between a detached listener and a dead channel. */
    getPtyDataListenerCount: () => number
    /** One-shot signal that this page's pty:data dispatcher is registered, so
     *  main can release sends held during the load/reload boot window. */
    rendererDispatcherReady: () => void
    setActiveRendererPty: (id: string, active: boolean) => void
    setRendererPtyVisible: (id: string, visible: boolean) => void
    /** Hidden-delivery gate (Phase 4): hidden=true lets main drop renderer
     *  byte delivery after model ingestion; reveal restores from snapshots. */
    setHiddenRendererPty: (id: string, hidden: boolean) => void
    /** Ref-counted-on-the-renderer delivery-interest signal that suppresses
     *  the hidden-delivery gate while any raw-byte consumer is registered. */
    setPtyDeliveryInterest: (id: string, interested: boolean) => void
    /** View-attribute bridge (Phase 5 slice 2): app-global composed terminal
     *  appearance push backing main's hidden-PTY OSC/DSR color replies. */
    publishTerminalViewAttributes: (attributes: TerminalViewAttributes) => void
    hasChildProcesses: (id: string) => Promise<boolean>
    getForegroundProcess: (id: string) => Promise<string | null>
    inspectProcess: (id: string) => Promise<{
      foregroundProcess: string | null
      hasChildProcesses: boolean
      unavailable?: true
    }>
    confirmForegroundProcess: (id: string) => Promise<string | null>
    getCwd: (id: string) => Promise<string>
    getSize: (id: string) => Promise<{ cols: number; rows: number } | null>
    listSessions: () => Promise<PtyListedSession[]>
    getAuthoritativeBufferSnapshotCapabilities?: (
      ids: string[]
    ) => Promise<{ id: string; authoritative: boolean | null }[]>
    hasPty: (id: string) => Promise<boolean | null>
    getMainBufferSnapshot: (
      id: string,
      opts?: { scrollbackRows?: number }
    ) => Promise<{
      data: string
      frameRestoreAnsi?: string
      cols: number
      rows: number
      cwd?: string | null
      seq?: number
      /** Start of main's pending renderer-delivery queue at snapshot time
       *  (equals `seq` when empty) — bounds the renderer's post-restore
       *  duplicate window. */
      pendingDeliveryStartSeq?: number
      source?: 'headless' | 'renderer'
      alternateScreen?: boolean
      /** Authoritative normal buffer paired with an alternate-screen frame. */
      scrollbackAnsi?: string
      /** Trailing incomplete escape the emulator ingested; the restorer must
       *  write it after its post-replay resets, last before live chunks. */
      pendingEscapeTailAnsi?: string
      /** Effective kitty flags the snapshot owner proved at `seq`. Absent means
       *  unknown; consumers must not turn that into a known `0`. */
      kittyKeyboardFlags?: number
    } | null>
    getRendererDeliveryDebugSnapshot: () => Promise<{
      pendingPtyCount: number
      pendingChars: number
      maxPendingCharsByPty: number
      rendererInFlightPtyCount: number
      rendererInFlightChars: number
      maxRendererInFlightCharsByPty: number
      activeRendererPtyCount: number
      flushScheduled: boolean
      peakPendingChars: number
      peakMaxPendingCharsByPty: number
      peakRendererInFlightChars: number
      peakMaxRendererInFlightCharsByPty: number
      ackGatedFlushSkipCount: number
      hiddenDeliveryGatedPtyCount: number
      hiddenDeliveryGatedVisiblePtyCount: number
      hiddenDeliveryGatedActivePtyCount: number
      deliveryInterestPtyCount: number
      hiddenDeliveryDroppedChars: number
      hiddenDeliveryDroppedChunks: number
      pendingDroppedChars: number
      diagnostics: PtyMainDeliveryDiagnostics
      rendererLifecycleResetCount: number
      lastLifecycleResetClearedChars: number
      rendererPtyDispatcherReady: boolean
      rendererDispatcherReadyForcedCount: number
    }>
    resetRendererDeliveryDebug: () => Promise<void>
    onData: (
      callback: (data: {
        id: string
        data: string
        seq?: number
        rawLength?: number
        transformed?: boolean
        background?: boolean
        droppedOutput?: boolean
      }) => void
    ) => () => void
    onReplay: (callback: (data: { id: string; data: string }) => void) => () => void
    /** Out-of-band main→renderer signal that renderer-bound bytes were
     *  dropped (hidden-delivery gate / pending cap); the pane restores from
     *  the model snapshot. Never delivered in-band on pty:data. */
    onModelRestoreNeeded: (callback: (event: PtyModelRestoreNeededEvent) => void) => () => void
    /** Batched derived side-effect facts for PTYs whose bytes transit local
     *  main. */
    onSideEffect: (callback: (batch: TerminalSideEffectBatch) => void) => () => void
    /** Title-only replay snapshot for (re)attach; attention facts never replay. */
    getSideEffectSnapshot: (id: string) => Promise<TerminalSideEffectBatch | null>
    onExit: (
      callback: (data: { id: string; code: number; preserveRendererBinding?: boolean }) => void
    ) => () => void
    onSpawned: (callback: (data: { id: string }) => void) => () => void
    onSerializeBufferRequest: (
      callback: (data: {
        requestId: string
        ptyId: string
        opts?: { scrollbackRows?: number; altScreenForcesZeroRows?: boolean }
      }) => void
    ) => () => void
    onClearBufferRequest: (callback: (data: { ptyId: string }) => void) => () => void
    sendSerializedBuffer: (
      requestId: string,
      snapshot: {
        data: string
        cols: number
        rows: number
        seq?: number
        lastTitle?: string
        kittyKeyboardFlags?: number
      } | null
    ) => void
    declarePendingPaneSerializer: (paneKey: string) => Promise<number>
    settlePaneSerializer: (paneKey: string, gen: number) => Promise<void>
    clearPendingPaneSerializer: (paneKey: string, gen: number) => Promise<void>
    reportRendererSerializerReady?: (ptyId: string) => Promise<void>
    management: PtyManagementApi
  }
  feedback: {
    submit: (args: {
      feedback: string
      submitAnonymously?: boolean
      githubLogin: string | null
      githubEmail: string | null
      images?: { contentType: string; data: Uint8Array }[]
    }) => Promise<
      { ok: true; imagesDelivered?: boolean } | { ok: false; status: number | null; error: string }
    >
  }
  crashReports: {
    getLatestPending: () => Promise<CrashReportRecord | null>
    getLatestReport: () => Promise<CrashReportRecord | null>
    dismiss: (args: { reportId: string }) => Promise<CrashReportRecord | null>
    recordRendererError: (
      args: ReactErrorBoundaryReportArgs
    ) => Promise<ReactErrorBoundaryReportResult>
    recordBreadcrumb: (args: { name: string; data?: CrashReportBreadcrumbData }) => void
    submit: (args: CrashReportSubmitArgs) => Promise<CrashReportSubmitResult>
    copyLatestDiagnostics: (
      args?: CrashReportCopyDiagnosticsArgs
    ) => Promise<{ ok: true } | { ok: false; error: string }>
    /** Exact V8/Blink heap sizes; null when the runtime withholds them. */
    readHeapStatistics: () => RendererHeapStatistics | null
  }
  export: ExportApi
  gh: Merged<GithubPullRequestApi & GithubWorkItemApi>
  hostedReview: HostedReviewApi
  gl: GitLabApi
  bitbucket: BitbucketApi
  linear: LinearApi
  jira: JiraApi
  starNag: StarNagApi
  telemetryTrack: TelemetryApi['telemetryTrack']
  telemetrySetOptIn: TelemetryApi['telemetrySetOptIn']
  diagnostics: DiagnosticsApi
  telemetryGetConsentState: TelemetryApi['telemetryGetConsentState']
  telemetryAcknowledgeBanner: TelemetryApi['telemetryAcknowledgeBanner']
  settings: SettingsApi
  agentAwake: AgentAwakeApi
  localhostWorktreeLabels: LocalhostWorktreeLabelsApi
  keybindings: KeybindingsApi
  codexAccounts: CodexAccountsApi
  claudeAccounts: ClaudeAccountsApi
  cli: CliApi
  codexConfigSync: CodexConfigSyncApi
  agentHooks: AgentHooksApi
  agentTrust: AgentTrustApi
  preflight: PreflightApi
  notifications: NotificationsApi
  onboarding: OnboardingApi
  dashboard: DashboardApi
  terminalPreview: TerminalPreviewApi
  macosTccPrompts: MacosTccPromptsApi
  developerPermissions: DeveloperPermissionsApi
  computerUsePermissions: ComputerUsePermissionsApi
  shell: ShellApi
  skills: SkillsApi
  pet: PetApi
  browser: BrowserApi
  emulator: EmulatorApi
  hooks: HooksApi
  ephemeralVm: EphemeralVmApi
  cache: WorkspaceSessionApi['cache']
  session: WorkspaceSessionApi['session']
  remoteWorkspace: WorkspaceSessionApi['remoteWorkspace']
  updater: UpdaterApi
  notebook: FilesystemApi['notebook']
  stats: StatsApi
  memory: MemoryApi
  claudeUsage: ClaudeUsageApi
  codexUsage: CodexUsageApi
  openCodeUsage: OpenCodeUsageApi
  aiVault: AiVaultApi
  nativeChat: NativeChatApi
  fs: {
    readDir: (args: { dirPath: string; connectionId?: string }) => Promise<DirEntry[]>
    readFile: (args: {
      filePath: string
      connectionId?: string
      includeLocalLogMetadata?: boolean
    }) => Promise<{
      content: string
      isBinary: boolean
      isImage?: boolean
      mimeType?: string
      fileIdentity?: string
    }>
    readLocalLogTail: (args: LocalLogTailReadArgs) => Promise<LocalLogTailReadResult>
    startLocalLogTail: (args: LocalLogTailWatchArgs) => Promise<void>
    stopLocalLogTail: (args: { subscriptionId: string }) => Promise<void>
    onLocalLogTailChanged: (callback: (payload: LocalLogTailChangedPayload) => void) => () => void
    downloadFile: (args: {
      filePath: string
      connectionId: string
    }) => Promise<{ canceled: true } | { canceled: false; destinationPath: string }>
    downloadFolder: (args: {
      dirPath: string
      connectionId: string
    }) => Promise<{ canceled: true } | { canceled: false; destinationPath: string }>
    saveDownloadedFile: (args: {
      suggestedName: string
      content: string
      encoding: 'utf8' | 'base64'
    }) => Promise<{ canceled: true } | { canceled: false; destinationPath: string }>
    startDownloadedFile: (args: {
      suggestedName: string
    }) => Promise<
      { canceled: true } | { canceled: false; transferId: string; destinationPath: string }
    >
    appendDownloadedFileChunk: (args: {
      transferId: string
      contentBase64: string
    }) => Promise<{ ok: true }>
    finishDownloadedFile: (args: {
      transferId: string
    }) => Promise<{ canceled: false; destinationPath: string }>
    cancelDownloadedFile: (args: { transferId: string }) => Promise<{ ok: true }>
    listMarkdownDocuments: (args: {
      rootPath: string
      connectionId?: string
    }) => Promise<MarkdownDocument[]>
    writeFile: (
      args: { filePath: string; content: string; connectionId?: string } & SshMutationExpectation
    ) => Promise<void>
    createFile: (
      args: { filePath: string; connectionId?: string } & SshMutationExpectation
    ) => Promise<void>
    createDir: (
      args: { dirPath: string; connectionId?: string } & SshMutationExpectation
    ) => Promise<void>
    rename: (
      args: { oldPath: string; newPath: string; connectionId?: string } & SshMutationExpectation
    ) => Promise<void>
    copy: (
      args: {
        sourcePath: string
        destinationPath: string
        connectionId?: string
      } & SshMutationExpectation
    ) => Promise<void>
    deletePath: (
      args: {
        targetPath: string
        connectionId?: string
        recursive?: boolean
      } & SshMutationExpectation
    ) => Promise<void>
    authorizeExternalPath: (args: { targetPath: string }) => Promise<void>
    stat: (args: {
      filePath: string
      connectionId?: string
    }) => Promise<{ size: number; isDirectory: boolean; mtime: number }>
    pathExists: (args: { filePath: string; connectionId?: string }) => Promise<boolean>
    listFiles: (args: {
      rootPath: string
      connectionId?: string
      excludePaths?: string[]
      requestToken?: string
    }) => Promise<string[]>
    cancelListFiles: (args: { requestToken: string }) => Promise<void>
    search: (args: SearchOptions & { connectionId?: string }) => Promise<SearchResult>
    importExternalPaths: (
      args: {
        sourcePaths: string[]
        destDir: string
        connectionId?: string
        ensureDir?: boolean
      } & SshMutationExpectation
    ) => Promise<{
      results: (
        | {
            sourcePath: string
            status: 'imported'
            destPath: string
            kind: 'file' | 'directory'
            renamed: boolean
          }
        | {
            sourcePath: string
            status: 'skipped'
            reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
          }
        | {
            sourcePath: string
            status: 'failed'
            reason: string
          }
      )[]
    }>
    stageExternalPathsForRuntimeUpload: (args: { sourcePaths: string[] }) => Promise<{
      sources: (
        | {
            sourcePath: string
            status: 'staged'
            name: string
            kind: 'file' | 'directory'
            entries: (
              | { relativePath: string; kind: 'directory' }
              | { relativePath: string; kind: 'file'; contentBase64: string }
            )[]
          }
        | {
            sourcePath: string
            status: 'skipped'
            reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
          }
        | {
            sourcePath: string
            status: 'failed'
            reason: string
          }
      )[]
    }>
    resolveDroppedPathsForAgent: (
      args: {
        paths: string[]
        worktreePath: string
        connectionId?: string
      } & SshMutationExpectation
    ) => Promise<{
      resolvedPaths: string[]
      skipped: {
        sourcePath: string
        reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
      }[]
      failed: { sourcePath: string; reason: string }[]
    }>
    watchWorktree: (args: { worktreePath: string; connectionId?: string }) => Promise<void>
    unwatchWorktree: (args: { worktreePath: string; connectionId?: string }) => Promise<void>
    onFsChanged: (callback: (payload: FsChangedPayload) => void) => () => void
  }
  git: {
    status: (args: {
      worktreePath: string
      connectionId?: string
      includeIgnored?: boolean
      bypassEffectiveUpstreamNegativeCache?: boolean
      reuseLineStats?: boolean
      /** Merge-base OID to measure the branch line total against; omit to skip the work. */
      branchLineTotalMergeBase?: string
      requestToken?: string
    }) => Promise<GitStatusResult>
    cancelStatus: (args: { requestToken: string }) => Promise<void>
    setStatusUpstreamRefWatch: (args: {
      worktreeId: string
      worktreePath: string
      executionHostId: string
      connectionId?: string
      branch?: string
      upstreamName?: string
    }) => Promise<void>
    submoduleStatus: (args: {
      worktreePath: string
      submodulePath: string
      connectionId?: string
      area?: GitStagingArea
    }) => Promise<GitStatusResult>
    checkIgnored: (args: {
      worktreePath: string
      paths: string[]
      connectionId?: string
    }) => Promise<string[]>
    findHugeFoldersToIgnore: (args: { worktreePath: string }) => Promise<string[]>
    appendGitignore: (args: { worktreePath: string; folderName: string }) => Promise<boolean>
    history: (
      args: { worktreePath: string; connectionId?: string } & GitHistoryOptions
    ) => Promise<GitHistoryResult>
    conflictOperation: (args: {
      worktreePath: string
      connectionId?: string
    }) => Promise<GitConflictOperation>
    abortMerge: (args: { worktreePath: string; connectionId?: string }) => Promise<void>
    abortRebase: (args: { worktreePath: string; connectionId?: string }) => Promise<void>
    diff: (args: {
      worktreePath: string
      filePath: string
      staged: boolean
      compareAgainstHead?: boolean
      connectionId?: string
    }) => Promise<GitDiffResult>
    branchCompare: (args: {
      worktreePath: string
      baseRef: string
      connectionId?: string
    }) => Promise<GitBranchCompareResult>
    commitCompare: (args: {
      worktreePath: string
      commitId: string
      connectionId?: string
    }) => Promise<GitCommitCompareResult>
    upstreamStatus: (args: {
      worktreePath: string
      connectionId?: string
      pushTarget?: GitPushTarget
    }) => Promise<GitUpstreamStatus>
    fetch: (args: {
      worktreePath: string
      connectionId?: string
      pushTarget?: GitPushTarget
    }) => Promise<void>
    syncFork: (args: {
      worktreePath: string
      connectionId?: string
      expectedUpstream: GitForkSyncExpectedUpstream
    }) => Promise<GitForkSyncResult>
    push: (args: {
      worktreePath: string
      publish?: boolean
      forceWithLease?: boolean
      connectionId?: string
      pushTarget?: GitPushTarget
    }) => Promise<void>
    pull: (args: {
      worktreePath: string
      connectionId?: string
      pushTarget?: GitPushTarget
    }) => Promise<void>
    fastForward: (args: {
      worktreePath: string
      connectionId?: string
      pushTarget?: GitPushTarget
    }) => Promise<void>
    rebaseFromBase: (args: {
      worktreePath: string
      baseRef: string
      connectionId?: string
    }) => Promise<void>
    branchDiff: (args: {
      worktreePath: string
      compare: {
        baseRef: string
        baseOid: string
        headOid: string
        mergeBase: string
      }
      filePath: string
      oldPath?: string
      connectionId?: string
    }) => Promise<GitDiffResult>
    commitDiff: (args: {
      worktreePath: string
      commitOid: string
      parentOid?: string | null
      filePath: string
      oldPath?: string
      connectionId?: string
    }) => Promise<GitDiffResult>
    commit: (args: {
      worktreePath: string
      message: string
      connectionId?: string
    }) => Promise<{ success: boolean; error?: string }>
    generateCommitMessage: (args: {
      worktreePath: string
      /** Raw (unstripped) worktree meta key; validated against worktreePath in main. */
      worktreeId?: string
      repoId?: string
      connectionId?: string
      sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
      sourceControlAi?: SourceControlAiSettings
      agentCmdOverrides?: Partial<Record<TuiAgent, string>>
    }) => Promise<
      | { success: true; message: string; agentLabel?: string }
      | { success: false; error: string; canceled?: boolean }
    >
    discoverCommitMessageModels: (args: {
      agentId: string
      worktreePath?: string
      connectionId?: string
    }) => Promise<
      | {
          success: true
          capability: CommitMessageAgentCapability
          models: CommitMessageModelCapability[]
          defaultModelId: string
          catalogOrigin: 'probe' | 'spec'
        }
      | { success: false; error: string }
    >
    cancelGenerateCommitMessage: (args: {
      worktreePath: string
      connectionId?: string
    }) => Promise<void>
    generatePullRequestFields: (args: {
      worktreePath: string
      /** Raw (unstripped) worktree meta key; validated against worktreePath in main. */
      worktreeId?: string
      repoId?: string
      base: string
      title: string
      body: string
      draft: boolean
      provider?: HostedReviewProvider
      useTemplate?: boolean
      connectionId?: string
      sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
      sourceControlAi?: SourceControlAiSettings
      agentCmdOverrides?: Partial<Record<TuiAgent, string>>
    }) => Promise<
      | {
          success: true
          fields: { base: string; title: string; body: string; draft: boolean }
          agentLabel?: string
          branchChangedByPreparation?: boolean
        }
      | { success: false; error: string; canceled?: boolean; branchChangedByPreparation?: boolean }
    >
    cancelGeneratePullRequestFields: (args: {
      worktreePath: string
      connectionId?: string
    }) => Promise<void>
    stage: (args: {
      worktreePath: string
      filePath: string
      connectionId?: string
    }) => Promise<void>
    bulkStage: (args: {
      worktreePath: string
      filePaths: string[]
      connectionId?: string
    }) => Promise<void>
    unstage: (args: {
      worktreePath: string
      filePath: string
      connectionId?: string
    }) => Promise<void>
    bulkUnstage: (args: {
      worktreePath: string
      filePaths: string[]
      connectionId?: string
    }) => Promise<void>
    discard: (args: {
      worktreePath: string
      filePath: string
      connectionId?: string
    }) => Promise<void>
    bulkDiscard: (args: {
      worktreePath: string
      filePaths: string[]
      connectionId?: string
    }) => Promise<void>
    remoteFileUrl: (args: {
      worktreePath: string
      relativePath: string
      line: number
      connectionId?: string
    }) => Promise<string | null>
    remoteCommitUrl: (args: {
      worktreePath: string
      sha: string
      connectionId?: string
    }) => Promise<string | null>
  }
  ui: {
    get: () => Promise<PersistedUIState>
    set: (args: Partial<PersistedUIState>) => Promise<void>
    recordFeatureInteraction: (id: FeatureInteractionId) => Promise<PersistedUIState>
    onStateChanged: (callback: (ui: PersistedUIState) => void) => () => void
    onOpenSettings: (callback: () => void) => () => void
    /** Consumes a one-shot tray/menu-bar "open settings" intent queued before mount. */
    consumePendingOpenSettings: () => Promise<boolean>
    onOpenSetupGuide: (callback: () => void) => () => void
    onOpenFeatureTour: (callback: () => void) => () => void
    onOpenCrashReport: (callback: () => void) => () => void
    onToggleLeftSidebar: (callback: () => void) => () => void
    onToggleRightSidebar: (callback: () => void) => () => void
    onToggleWorktreePalette: (callback: () => void) => () => void
    onToggleFloatingTerminal: (callback: () => void) => () => void
    onTerminalShortcutCaptured: (
      callback: (data: { actionId: KeybindingActionId }) => void
    ) => () => void
    onOpenQuickOpen: (callback: () => void) => () => void
    onToggleQuickCommandsMenu: (callback: () => void) => () => void
    onOpenNewWorkspace: (callback: () => void) => () => void
    onDeleteCurrentWorkspace: (callback: () => void) => () => void
    onOpenWorkspaceBoard: (callback: () => void) => () => void
    onOpenTasks: (callback: () => void) => () => void
    onJumpToWorktreeIndex: (callback: (index: number) => void) => () => void
    onJumpToTabIndex: (callback: (index: number) => void) => () => void
    onWorktreeHistoryNavigate: (callback: (direction: 'back' | 'forward') => void) => () => void
    onNewBrowserTab: (callback: () => void) => () => void
    onNewMarkdownTab: (callback: () => void) => () => void
    onNewSimulatorTab: (callback: () => void) => () => void
    onRequestTabCreate: (
      callback: (data: {
        requestId: string
        url: string
        worktreeId?: string
        sessionProfileId?: string | null
        sessionPartition?: string
        activate?: boolean
      }) => void
    ) => () => void
    replyTabCreate: (reply: { requestId: string; browserPageId?: string; error?: string }) => void
    onRequestTabSetProfile: (
      callback: (data: {
        requestId: string
        browserPageId: string
        profileId: string
        sessionPartition?: string
      }) => void
    ) => () => void
    replyTabSetProfile: (reply: { requestId: string; error?: string }) => void
    onRequestTabClose: (
      callback: (data: { requestId: string; tabId: string | null; worktreeId?: string }) => void
    ) => () => void
    replyTabClose: (reply: { requestId: string; error?: string }) => void
    onNewTerminalTab: (callback: () => void) => () => void
    onFocusBrowserAddressBar: (callback: () => void) => () => void
    onFindInBrowserPage: (source: BrowserFindSource, callback: () => void) => () => void
    onReloadBrowserPage: (callback: () => void) => () => void
    onBrowserHistoryNavigate: (callback: (direction: 'back' | 'forward') => void) => () => void
    onZoomBrowserPage: (callback: (direction: 'in' | 'out' | 'reset') => void) => () => void
    onHardReloadBrowserPage: (callback: () => void) => () => void
    onCloseActiveTab: (callback: () => void) => () => void
    onCloseFloatingItem: (callback: (payload: { sourceId: string }) => void) => () => void
    onSelectFloatingIndex: (callback: (payload: { index: number }) => void) => () => void
    onSwitchTab: (callback: (direction: 1 | -1) => void) => () => void
    onSwitchTabAcrossAllTypes: (callback: (direction: 1 | -1) => void) => () => void
    onSwitchRecentTab: (callback: () => void) => () => void
    onSwitchTerminalTab: (callback: (direction: 1 | -1) => void) => () => void
    onCtrlTabKeyDown: (callback: (data: { shiftKey: boolean }) => void) => () => void
    onCtrlTabKeyUp: (callback: () => void) => () => void
    onToggleStatusBar: (callback: () => void) => () => void
    onDictationKeyDown: (callback: () => void) => () => void
    onExportPdfRequested: (callback: () => void) => () => void
    onAppMenuPaste: (callback: () => void) => () => void
    onAppMenuSelectionAction: (callback: (action: 'copy' | 'select-all') => void) => () => void
    onEditableContextPaste: (callback: (data: { plainTextOnly: boolean }) => void) => () => void
    onActivateWorktree: (
      callback: (data: {
        repoId: string
        worktreeId: string
        setup?: WorktreeSetupLaunch
        startup?: WorktreeStartupLaunch
        defaultTabs?: WorktreeDefaultTabsLaunch
      }) => void
    ) => () => void
    onCreateTerminal: (
      callback: (data: {
        requestId?: string
        worktreeId: string
        command?: string
        cwd?: string
        env?: Record<string, string>
        launchConfig?: SleepingAgentLaunchConfig
        resumeProviderSession?: AgentProviderSessionMetadata
        launchToken?: string
        launchAgent?: TuiAgent
        viewMode?: 'terminal' | 'chat'
        terminalDockByPaneKey?: Record<string, TerminalDockPaneState>
        title?: string
        ptyId?: string
        activate?: boolean
        focus?: boolean
        presentation?: RuntimeTerminalPresentation
        surfaceOwner?: false
        tabId?: string
        leafId?: string
        splitFromLeafId?: string
        splitDirection?: 'horizontal' | 'vertical'
        splitTelemetrySource?: TerminalPaneSplitSource
      }) => void
    ) => () => void
    onRequestTerminalCreate: (
      callback: (data: RuntimeTerminalCreateRequestPayload) => void
    ) => () => void
    onRequestTerminalTabMount: (
      callback: (data: { worktreeId: string; tabId?: string; ptyId?: string }) => void
    ) => () => void
    replyTerminalCreate: (reply: TerminalTabCreateReply) => void
    onSplitTerminal: (
      callback: (data: {
        tabId: string
        paneRuntimeId: number
        direction: 'horizontal' | 'vertical'
        command?: string
        telemetrySource?: TerminalPaneSplitSource
      }) => void
    ) => () => void
    onRenameTerminal: (
      callback: (data: { tabId: string; title: string | null }) => void
    ) => () => void
    onFocusTerminal: (
      callback: (data: {
        tabId: string
        worktreeId: string
        leafId?: string | null
        ackPaneKeyOnSuccess?: string
        flashFocusedPane?: boolean
        scrollToBottomIfOutputSinceLastView?: boolean
      }) => void
    ) => () => void
    onFocusEditorTab: (
      callback: (data: { tabId: string; worktreeId: string }) => void
    ) => () => void
    onCloseSessionTab: (
      callback: (data: { tabId: string; worktreeId: string }) => void
    ) => () => void
    onMoveSessionTab: (
      callback: (data: { worktreeId: string } & RuntimeMobileSessionTabMove) => void
    ) => () => void
    onOpenFileFromMobile: (
      callback: (data: {
        worktreeId: string
        filePath: string
        relativePath: string
        runtimeEnvironmentId?: string
      }) => void
    ) => () => void
    onOpenDiffFromMobile: (
      callback: (data: {
        worktreeId: string
        filePath: string
        relativePath: string
        staged: boolean
        runtimeEnvironmentId?: string
      }) => void
    ) => () => void
    onMobileMarkdownRequest: (
      callback: (request: RuntimeMobileMarkdownRequest) => void
    ) => () => void
    respondMobileMarkdownRequest: (response: RuntimeMobileMarkdownResponse) => void
    onCloseTerminal: (
      callback: (data: { tabId: string; paneRuntimeId?: number }) => void
    ) => () => void
    onTerminalTabCloseRequest: (callback: (request: TerminalTabCloseRequest) => void) => () => void
    respondTerminalTabClose: (response: TerminalTabCloseResponse) => void
    onSleepWorktree: (callback: (data: { worktreeId: string }) => void) => () => void
    onResumeSleepingAgents: (callback: (data: { worktreeId: string }) => void) => () => void
    onTerminalZoom: (callback: (direction: 'in' | 'out' | 'reset') => void) => () => void
    onSystemResumed: (callback: () => void) => () => void
    readClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
    readSelectionClipboardText: (options?: ReadClipboardTextOptions) => Promise<string>
    saveClipboardImageAsTempFile: (args?: {
      connectionId?: string | null
      runtimeEnvironmentId?: string | null
    }) => Promise<string | null>
    writeClipboardText: (text: string) => Promise<void>
    writeTerminalClipboardText: (text: string) => Promise<void>
    writeSelectionClipboardText: (text: string) => Promise<void>
    writeClipboardImage: (dataUrl: string) => Promise<void>
    performNativePaste: (options?: { mode?: 'paste' | 'paste-and-match-style' }) => void
    performNativeSelectionAction: (action: 'copy' | 'select-all') => void
    writeClipboardFile: (
      args:
        | {
            filePath: string
            connectionId?: string | null
          }
        | string
    ) => Promise<{ ok: boolean; reason?: string }>
    onFileDrop: (callback: (data: NativeFileDropPayload) => void) => () => void
    getZoomLevel: () => number
    setZoomLevel: (level: number) => void
    syncTrafficLights: (zoomFactor: number) => void
    setMarkdownEditorFocused: (focused: boolean) => void
    setRichMarkdownContextMenuTarget: (target: RichMarkdownContextMenuTableTarget | null) => void
    setTerminalInputFocused: (focused: boolean) => void
    setFloatingFocus: (state: { panelFocused: boolean; terminalFocused: boolean }) => void
    setShortcutRecorderFocused: (focused: boolean) => void
    onRichMarkdownContextCommand: (
      callback: (payload: RichMarkdownContextMenuCommandPayload) => void
    ) => () => void
    onFullscreenChanged: (callback: (isFullScreen: boolean) => void) => () => void
    minimize: () => void
    maximize: () => void
    isMaximized: () => Promise<boolean>
    onMaximizeChanged: (callback: (isMaximized: boolean) => void) => () => void
    requestClose: () => void
    popupMenu: () => void
    onWindowCloseRequested: (callback: (data: { isQuitting: boolean }) => void) => () => void
    confirmWindowClose: () => void
    notifyWindowRevealed: () => void
  }
  runtime: {
    syncWindowGraph: (graph: RuntimeSyncWindowGraph) => Promise<RuntimeSyncWindowGraphResult>
    getStatus: () => Promise<RuntimeStatus>
    call: (args: { method: string; params?: unknown }) => Promise<RuntimeRpcResponse<unknown>>
    getTerminalFitOverrides: () => Promise<
      { ptyId: string; mode: 'mobile-fit' | 'remote-desktop-fit'; cols: number; rows: number }[]
    >
    getTerminalDrivers: () => Promise<
      {
        ptyId: string
        driver: RuntimeTerminalDriverState
      }[]
    >
    getBrowserDrivers: () => Promise<
      {
        browserPageId: string
        driver: RuntimeBrowserDriverState
      }[]
    >
    restoreTerminalFit: (ptyId: string) => Promise<{ restored: boolean }>
    reclaimBrowserForDesktop: (browserPageId: string) => Promise<{ reclaimed: boolean }>
    onTerminalFitOverrideChanged: (
      callback: (event: {
        ptyId: string
        mode: 'mobile-fit' | 'remote-desktop-fit' | 'desktop-fit'
        cols: number
        rows: number
      }) => void
    ) => () => void
    onTerminalDriverChanged: (
      callback: (event: { ptyId: string; driver: RuntimeTerminalDriverState }) => void
    ) => () => void
    onNativeChatLaunchDraftResolved?: (
      callback: (event: { tabId: string; text: string; createdAt: number }) => void
    ) => () => void
    onBrowserDriverChanged: (
      callback: (event: { browserPageId: string; driver: RuntimeBrowserDriverState }) => void
    ) => () => void
  }
  runtimeEnvironments: {
    list: () => Promise<PublicKnownRuntimeEnvironment[]>
    addFromPairingCode: (args: {
      name: string
      pairingCode: string
    }) => Promise<{ environment: PublicKnownRuntimeEnvironment }>
    verifyAndAddFromPairingCode: (args: {
      name: string
      pairingCode: string
      allowLoopback?: boolean
    }) => Promise<VerifyAndAddRuntimeEnvironmentResult>
    resolve: (args: { selector: string }) => Promise<PublicKnownRuntimeEnvironment>
    remove: (args: { selector: string }) => Promise<{ removed: PublicKnownRuntimeEnvironment }>
    disconnect: (args: {
      selector: string
    }) => Promise<{ disconnected: PublicKnownRuntimeEnvironment }>
    connect: (args: {
      selector: string
      timeoutMs?: number
    }) => Promise<RuntimeRpcResponse<RuntimeStatus>>
    getStatus: (args: {
      selector: string
      timeoutMs?: number
    }) => Promise<RuntimeRpcResponse<RuntimeStatus>>
    // Why: system resume / browser online advance pending shared-control reconnect timers only.
    retryConnectionsNow?: () => Promise<void>
    call: (args: {
      selector: string
      method: string
      params?: unknown
      timeoutMs?: number
      expectedEnvironmentPairingRevision?: number
    }) => Promise<RuntimeRpcResponse<unknown>>
    subscribe: (
      args: {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
        expectedEnvironmentPairingRevision?: number
      },
      callbacks: {
        onResponse: (response: RuntimeRpcResponse<unknown>) => void
        onBinary?: (bytes: Uint8Array<ArrayBufferLike>) => void
        onError?: (error: { code: string; message: string }) => void
        onClose?: () => void
      }
    ) => Promise<RuntimeEnvironmentSubscriptionHandle>
  }
  rateLimits: {
    get: () => Promise<RateLimitState>
    refresh: () => Promise<RateLimitState>
    refreshCodexForTarget: (target: RateLimitRuntimeTarget) => Promise<RateLimitState>
    consumeCodexResetCredit: () => Promise<CodexRateLimitResetResult>
    refreshClaudeForTarget: (target: RateLimitRuntimeTarget) => Promise<RateLimitState>
    setPollingInterval: (ms: number) => Promise<void>
    fetchInactiveClaudeAccounts: () => Promise<void>
    fetchInactiveCodexAccounts: () => Promise<void>
    refreshMiniMax: () => Promise<RateLimitState>
    refreshGrok: () => Promise<RateLimitState>
    onUpdate: (callback: (state: RateLimitState) => void) => () => void
  }
  minimaxCredentials: {
    getStatus: () => Promise<{ configured: boolean }>
    saveCookie: (cookie: string) => Promise<{ configured: boolean }>
    clearCookie: () => Promise<{ configured: boolean }>
  }
  grokAccounts: {
    getStatus: () => Promise<GrokAccountStatus>
  }
  ssh: {
    listTargets: () => Promise<SshTarget[]>
    // Removed-target id → last known label, for a friendly host name on workspaces still pinned to a removed target.
    listRemovedTargetLabels: () => Promise<Record<string, string>>
    addTarget: (args: { target: Omit<SshTarget, 'id'> }) => Promise<SshTargetAddResult>
    updateTarget: (args: {
      id: string
      updates: Partial<Omit<SshTarget, 'id'>>
    }) => Promise<SshTarget>
    removeTarget: (args: { id: string }) => Promise<void>
    importConfig: (args?: { reAdopt?: boolean }) => Promise<SshConfigImportResult>
    listConfigHosts: (args?: SshConfigHostListArgs) => Promise<SshConfigHostListResult>
    resolveConfigHost: (args: { alias: string }) => Promise<SshConfigHostResolution | null>
    connect: (args: { targetId: string }) => Promise<SshConnectionState | null>
    disconnect: (args: { targetId: string }) => Promise<void>
    terminateSessions: (args: { targetId: string }) => Promise<void>
    resetRelay: (args: { targetId: string }) => Promise<void>
    getState: (args: { targetId: string }) => Promise<SshConnectionState | null>
    needsPassphrasePrompt: (args: { targetId: string }) => Promise<boolean>
    testConnection: (args: {
      targetId: string
    }) => Promise<{ success: boolean; error?: string; state?: SshConnectionState }>
    onStateChanged: (
      callback: (data: { targetId: string; state: SshConnectionState }) => void
    ) => () => void
    addPortForward: (args: {
      targetId: string
      localPort: number
      remoteHost: string
      remotePort: number
      label?: string
    }) => Promise<PortForwardEntry>
    updatePortForward: (args: {
      id: string
      targetId: string
      localPort: number
      remoteHost: string
      remotePort: number
      label?: string
    }) => Promise<PortForwardEntry>
    removePortForward: (args: { id: string }) => Promise<PortForwardEntry | null>
    listPortForwards: (args?: { targetId?: string }) => Promise<PortForwardEntry[]>
    listDetectedPorts: (args: { targetId: string }) => Promise<EnrichedDetectedPort[]>
    onPortForwardsChanged: (
      callback: (data: { targetId: string; forwards: PortForwardEntry[] }) => void
    ) => () => void
    onDetectedPortsChanged: (
      callback: (data: { targetId: string; ports: EnrichedDetectedPort[] }) => void
    ) => () => void
    browseDir: (args: { targetId: string; dirPath: string }) => Promise<{
      entries: { name: string; isDirectory: boolean }[]
      resolvedPath: string
      pathFlavor: FilesystemPathFlavor
    }>
    onCredentialRequest: (
      callback: (data: {
        requestId: string
        targetId: string
        kind: 'passphrase' | 'password'
        detail: string
      }) => void
    ) => () => void
    onCredentialResolved: (callback: (data: { requestId: string }) => void) => () => void
    submitCredential: (args: { requestId: string; value: string | null }) => Promise<void>
  }
  automations: {
    list: () => Promise<Automation[]>
    listRuns: (args?: { automationId?: string }) => Promise<AutomationRun[]>
    listExternalManagers: () => Promise<ExternalAutomationManager[]>
    listExternalRuns: (input: ExternalAutomationRunsInput) => Promise<ExternalAutomationRunsPage>
    createExternal: (input: ExternalAutomationCreateInput) => Promise<void>
    updateExternal: (input: ExternalAutomationUpdateInput) => Promise<void>
    runExternalAction: (input: ExternalAutomationActionInput) => Promise<void>
    create: (input: AutomationCreateInput) => Promise<Automation>
    update: (args: { id: string; updates: AutomationUpdateInput }) => Promise<Automation>
    delete: (args: { id: string }) => Promise<void>
    runNow: (args: { id: string }) => Promise<AutomationRun>
    runPrecheck: (args: {
      automationId: string
      runId: string
    }) => Promise<AutomationPrecheckResult | null>
    markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
    snapshotWorkspaceName: (args: { workspaceId: string; displayName: string }) => Promise<number>
    rendererReady: () => Promise<void>
    onDispatchRequested: (callback: (request: AutomationDispatchRequest) => void) => () => void
  }
  wsl: {
    isAvailable: () => Promise<boolean>
    listDistros: () => Promise<string[]>
  }
  pwsh: {
    isAvailable: () => Promise<boolean>
  }
  gitBash: {
    isAvailable: () => Promise<boolean>
  }
  plugins: {
    list: () => Promise<PluginHostListEntry[]>
    listLanguagePacks: () => Promise<PluginLanguagePackRegistration[]>
    /** Records the consent-dialog answer; approval is keyed to the plugin's
     *  current capability and trusted-worker fingerprint. */
    consent: (args: PluginConsentRequest) => Promise<PluginHostListEntry[]>
    setEnabled: (args: { pluginKey: string; enabled: boolean }) => Promise<PluginHostListEntry[]>
    /** Returns the panel's CSP-wrapped HTML, or null when the plugin or
     *  panel is missing/disabled. Rendered only inside a sandboxed iframe. */
    readPanelEntry: (args: {
      pluginKey: string
      panelId: string
    }) => Promise<PluginPanelEntry | null>
    invokeCommand: (args: {
      pluginKey: string
      commandId: string
      args?: unknown
    }) => Promise<unknown>
    /** Relays a sandboxed panel's bridge request to main, which enforces the
     *  plugin's consented capabilities before executing. */
    panelAction: (args: {
      sessionToken: string
      action: string
      params?: unknown
    }) => Promise<PluginPanelActionOutcome>
    install: (source: PluginHostInstallSource) => Promise<PluginHostInstallResult>
    listMarketplaces: () => Promise<PluginMarketplaceHostSourceState[]>
    addMarketplace: (
      source: PluginMarketplaceGitSource
    ) => Promise<PluginMarketplaceHostSourceState>
    removeMarketplace: (args: { sourceId: string }) => Promise<PluginMarketplaceHostSourceState[]>
    refreshMarketplaces: (args?: {
      sourceId?: string
    }) => Promise<PluginMarketplaceHostSourceState[]>
    listMarketplacePlugins: () => Promise<PluginMarketplaceHostListing[]>
    previewMarketplacePlugin: (args: {
      marketplaceSourceId: string
      pluginKey: string
    }) => Promise<PluginMarketplaceHostInstallPreview>
    installMarketplacePlugin: (
      preview: Pick<
        PluginMarketplaceHostInstallPreview,
        'marketplaceSourceId' | 'marketplaceCommit' | 'pluginKey' | 'resolvedCommit'
      >
    ) => Promise<PluginHostInstallResult>
    previewMarketplaceUpdate: (args: {
      pluginKey: string
    }) => Promise<PluginMarketplaceHostInstallPreview>
    rollbackMarketplacePlugin: (args: { pluginKey: string }) => Promise<PluginHostInstallResult>
    remove: (args: { pluginKey: string }) => Promise<PluginHostListEntry[]>
    getLogs: (args: { pluginKey: string }) => Promise<PluginHostLogLine[]>
    /** Re-discovers after settings edits (feature flag, dev paths). */
    refresh: () => Promise<PluginHostListEntry[]>
    /** Fires whenever installed plugins, worker states, panels, or content packs change. */
    onChanged: (callback: (event: PluginChangeEvent) => void) => () => void
  }
  agentStatus: {
    /** Listen for agent status updates forwarded from native hook receivers. */
    onSet: (callback: (data: AgentStatusIpcPayload) => void) => () => void
    /** Listen for main-process cleanup that evicted cached hook status. */
    onClear: (callback: (data: AgentStatusClearIpcPayload) => void) => () => void
    /** Return the current main-process hook cache after renderer hydration. */
    getSnapshot: () => Promise<AgentStatusIpcPayload[]>
    inferInterrupt: (request: AgentInterruptInferenceRequest) => Promise<boolean>
    /** Guarded clear for an answered AskUserQuestion wait — the CLI emits no hook at answer time, so the renderer reports the submit keystroke. */
    inferQuestionAnswered: (request: AgentQuestionAnsweredInferenceRequest) => Promise<boolean>
    /** Listen for PTYs on a legacy numeric pane key that have registry-backed UUID pane proof. */
    onMigrationUnsupported: (callback: (entry: MigrationUnsupportedPtyEntry) => void) => () => void
    onMigrationUnsupportedClear: (callback: (data: { ptyId: string }) => void) => () => void
    onLegacyWorkerTerminalRecovery: (
      callback: (data: {
        paneKey: string
        resolution: 'adopted' | 'exited' | 'rolled_back'
        ptyId?: string
      }) => void
    ) => () => void
    getMigrationUnsupportedSnapshot: () => Promise<MigrationUnsupportedPtyEntry[]>
    /** Drop a paneKey from the main-process hook cache and on-disk last-status file. Fire-and-forget. */
    drop: (paneKey: string) => void
    /** Drop every cached hook status under one terminal tab prefix. Fire-and-forget. */
    dropByTabPrefix: (tabId: string) => void
    /** Permanently retire one pane's hook authority while siblings stay live. */
    retirePaneAuthority: (paneKey: string) => void
    /** Move hook authority when a live pane is detached into another tab. */
    transferPaneAuthority: (args: {
      fromPaneKey: string
      toPaneKey: string
      ptyId?: string
    }) => void
  }
  mobile: {
    listNetworkInterfaces: () => Promise<{
      interfaces: { name: string; address: string; hasDefaultRoute?: boolean }[]
    }>
    getPairingQR: (args?: {
      address?: string
      connectionMode?: MobilePairingConnectionMode
      rotate?: boolean
    }) => Promise<
      | {
          available: false
          reason?: string
          guidance?: string
          relayFailure?: MobileRelayMintFailure
        }
      | {
          available: true
          qrDataUrl: string | null
          qrError?: 'encoding_failed'
          pairingUrl: string
          /** Null when no direct address was advertised — the QR pairs over Relay alone. */
          endpoint: string | null
          deviceId: string
          /** Mode the QR actually encodes. */
          connectionMode: MobilePairingConnectionMode
        }
    >
    getWindowsFirewallStatus: (args?: { address?: string }) => Promise<
      | { supported: false }
      | {
          supported: true
          port: number
          ruleAllowed: boolean
          blockingRuleDetected: boolean
          privateFirewallEnabled: boolean
          networkCategory: 'private' | 'public' | 'domain' | 'unknown'
          inspectionAvailable: boolean
        }
    >
    repairWindowsFirewall: () => Promise<
      { ok: true } | { ok: false; reason: 'cancelled' | 'failed' | 'unsupported' }
    >
    openWindowsNetworkSettings: () => Promise<boolean>
    getRuntimePairingUrl: (args?: {
      address?: string
      rotate?: boolean
      reach?: RuntimePairingReach
    }) => Promise<
      | { available: false; reason?: 'network_exposure_failed'; guidance?: string }
      | {
          available: true
          pairingUrl: string
          webClientUrl: string | null
          endpoint: string
          deviceId: string
        }
    >
    listDevices: () => Promise<{
      devices: { deviceId: string; name: string; pairedAt: number; lastSeenAt: number }[]
    }>
    revokeDevice: (args: { deviceId: string }) => Promise<{ revoked: boolean }>
    listRuntimeAccessGrants: () => Promise<{ grants: RuntimeAccessGrant[] }>
    revokeRuntimeAccess: (args: { deviceId: string }) => Promise<{ revoked: boolean }>
    isWebSocketReady: () => Promise<{ ready: boolean; endpoint: string | null }>
    getRelayStatus: () => Promise<{ status: MobileRelayStatus }>
    onRelayStatusChanged: (callback: (status: MobileRelayStatus) => void) => () => void
    /** Consumes an auth-failure notification that arrived before the renderer listener mounted. */
    consumePendingUnpairedDeviceAuthFailure?: () => Promise<boolean>
    /** Fires (throttled, once per session) when an unpaired phone repeatedly fails direct-transport auth. */
    onUnpairedDeviceAuthFailure?: (callback: () => void) => () => void
  }
  speech: {
    getCatalog: () => Promise<SpeechModelManifest[]>
    getModelStates: () => Promise<SpeechModelState[]>
    getOpenAiApiKeyStatus: () => Promise<{ configured: boolean }>
    saveOpenAiApiKey: (apiKey: string) => Promise<{ configured: boolean }>
    clearOpenAiApiKey: () => Promise<{ configured: boolean }>
    downloadModel: (modelId: string) => Promise<void>
    cancelDownload: (modelId: string) => Promise<void>
    deleteModel: (modelId: string) => Promise<void>
    startDictation: (
      modelId: string,
      hotwords: string[] | undefined,
      sessionId: string
    ) => Promise<void>
    feedAudio: (samples: Float32Array, sampleRate: number, sessionId?: string) => Promise<void>
    stopDictation: (sessionId?: string) => Promise<void>
    onPartialTranscript: (callback: (data: SpeechTranscriptEvent) => void) => () => void
    onFinalTranscript: (callback: (data: SpeechTranscriptEvent) => void) => () => void
    onDownloadProgress: (
      callback: (data: { modelId: string; progress: number }) => void
    ) => () => void
    onReady: (callback: (data: SpeechLifecycleEvent) => void) => () => void
    onStopped: (callback: (data: SpeechLifecycleEvent) => void) => () => void
    onError: (callback: (data: SpeechErrorEvent) => void) => () => void
  }
}

export type { ClaudeUsageApi, CodexUsageApi, OpenCodeUsageApi } from './api/agent-usage-api'
export type { AiVaultApi } from './api/ai-vault-api'
export type { AppApi } from './api/app-api'
export type { BrowserApi, DetectedBrowserInfo, DetectedBrowserProfileInfo } from './api/browser-api'
export type { EmulatorApi } from './api/emulator-api'
export type { ExportApi } from './api/filesystem-api'
export type {
  NativeChatApi,
  NativeChatAppendedMessages,
  NativeChatAppendedPayload,
  NativeChatReadSessionResult,
  NativeChatSubscribeArgs,
  NativeChatSubscriptionFrame
} from './api/native-chat-api'
export type {
  PluginHostInstallResult,
  PluginHostInstallSource,
  PluginHostListEntry,
  PluginHostLogLine,
  PluginHostPanel,
  PluginHostStatus,
  PluginMarketplaceHostInstallPreview,
  PluginMarketplaceHostListing,
  PluginMarketplaceHostSourceState
} from './api/plugin-host-api'
export type {
  PreflightApi,
  PreflightRuntimeContext,
  PreflightStatus,
  RefreshAgentsResult
} from './api/preflight-api'
export type {
  PtyManagementApi,
  PtyManagementMacTccAttributionHealth,
  PtyManagementSession
} from './api/pty-management-api'
export type {
  ShellOpenExternalEditorRequest,
  ShellOpenExternalEditorResult,
  ShellOpenLocalPathResult
} from './api/shell-api'
export type {
  DiagnosticsBundlePayload,
  DiagnosticsStatusPayload,
  DiagnosticsUploadPayload,
  MemoryApi,
  StatsApi
} from './api/telemetry-api'

declare global {
  // oxlint-disable-next-line typescript-eslint/consistent-type-definitions -- declaration merging requires interface
  interface Window {
    electron: ElectronAPI
    api: PreloadApi
  }
}
