/* eslint-disable max-lines -- main-process entry point; owns app lifecycle, service wiring, window creation, and hook/daemon startup with no cleaner split seam. */
import { existsSync, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import os from 'node:os'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
  type Tray,
  session
} from 'electron'
import { applyMacPressAndHoldDefaultAtStartup } from './macos-press-and-hold-default'
import { initTccPromptNotice, stopTccPromptNotice } from './macos-tcc-prompt-notice'
import { electronApp, is } from '@electron-toolkit/utils'
import {
  Store,
  initDataPath,
  getCanonicalUserDataPath,
  migrateMobilePairingDataToCanonicalUserDataPath
} from './persistence'
import { setAppEnvironment } from '../shared/app-environment'
import { ElectronAppEnvironment } from './host/electron-app-environment'
import { setPtyHostBindings } from './ipc/pty-host-bindings'
import { electronRuntimeDesktopSurface } from './host/electron-runtime-desktop-surface'
import { setRuntimeDesktopSurface } from './runtime/runtime-desktop-surface'
import { electronRuntimeBrowserCommandsFactory } from './host/electron-browser-commands'
import { setRuntimeBrowserCommandsFactory } from './runtime/runtime-browser-commands-factory'
import { electronHttpClient } from './host/electron-http-client'
import { setMainHttpClient } from './network/http-client'
import { electronSpeechServiceFactories } from './host/electron-speech-services'
import { setSpeechServiceFactories } from './speech/speech-runtime-service'
import { setWorktreeWatcherRemoval } from './ipc/worktree-watcher-removal'
import { setSecretStore } from '../shared/secret-store'
import { ElectronSecretStore } from './host/electron-secret-store'
import { scheduleSecretProtectionGapReport } from './host/deferred-secret-protection-report'
import { initSessionParseCachePersistence } from './ai-vault/session-parse-cache-persistence'
import { ensureActiveOrcaProfile, initOrcaProfilePaths } from './orca-profiles/profile-index-store'
import { getOrcaCloudAuthConfig } from './orca-profiles/profile-cloud-auth-config'
import { getProfileUserDataPath } from './orca-profiles/profile-storage-paths'
import { applyAppIcon } from './app-icon'
import { relaunchApp } from './app-relaunch'
import { StatsCollector, initStatsPath } from './stats/collector'
import { initSshHostKeyStoreFile } from './ssh/ssh-host-key-store'
import { AgentSessionTransitionRecorder } from './stats/agent-session-transition-recorder'
import { ClaudeUsageStore, initClaudeUsagePath } from './claude-usage/store'
import { CodexUsageStore, initCodexUsagePath } from './codex-usage/store'
import { OpenCodeUsageStore, initOpenCodeUsagePath } from './opencode-usage/store'
import {
  killAllPty,
  clearProviderPtyState,
  getPtyIdForPaneKey,
  registerPaneKeyTeardownListener,
  getLocalPtyProvider,
  getSshPtyProvider,
  registerHeadlessPtyRuntime,
  type CodexHomeLaunchContext
} from './ipc/pty'
import {
  initDaemonPtyProvider,
  disconnectDaemon,
  getDaemonProvider,
  listLiveDaemonPtyIds,
  shutdownDaemon
} from './daemon/daemon-init'
import {
  type CodexPaneHomeRoute,
  getCodexPaneAccount,
  hasAnyRecordedLegacyWslCodexPane,
  hasRecordedManagedHostCodexPane,
  isCodexPaneHomeRouteProvenAwayFromSharedHome,
  reconcileCodexPaneAccountsWithLivePtys
} from './codex/codex-pane-account-registry'
import { closeAllWatchers, desktopWorktreeWatcherRemoval } from './ipc/filesystem-watcher'
import { disposeWorktreeBaseDirectoryWatchers } from './ipc/worktree-base-directory-watcher'
import { stopFolderRepoGitUpgradeWatch } from './ipc/folder-repo-git-upgrade'
import { registerCoreHandlers } from './ipc/register-core-handlers/register-core-handlers'
import { initObservability, shutdownObservability } from './observability'
import { registerMobileHandlers } from './ipc/mobile'
import { initTelemetry, shutdownTelemetry, trackAppOpenedOnce, track } from './telemetry/client'
import { classifyError } from './telemetry/classify-error'
import { recordManagedHookInstallFailure } from './agent-hooks/install-telemetry'
import {
  indexPersistedPaneKeyPtyIds,
  isLocalExecutionHost,
  resolveAgentWorkspaceExecutionHostId,
  sweepRestoredSubagentsWithoutLiveAgent
} from './agent-hooks/restored-subagent-liveness-sweep'
import {
  installManagedAgentHooks,
  isAgentStatusHooksEnabled,
  removeManagedAgentHooksAsync,
  resolveStartupManagedHookAction,
  shouldInstallStartupManagedAgentHook,
  shouldContinueManagedHookStartup
} from './agent-hooks/managed-agent-hook-controls'
import { initCohortClassifier } from './telemetry/cohort-classifier'
import { initOnboardingCohortClassifier } from './telemetry/onboarding-cohort-classifier'
import { resolveConsent } from './telemetry/consent'
import { triggerStartupNotificationRegistration } from './ipc/startup-notification-registration'
import { OrcaRuntimeService, type RuntimeWorktreeLifecycleEvent } from './runtime/orca-runtime'
import { ArtifactCloudService } from './artifacts/fork-artifact-passwords/artifact-password-cloud-service'
import { SkillCloudService } from './skills/skill-cloud-service'
import { recoverPendingSkillTransactions } from './skills/skill-transaction-startup-recovery'
import { isArtifactSharingEnabled } from '../shared/artifact-sharing-gate'
import { loadAgentSessionClaimSigner } from './runtime/agent-session-claim-identity'
import {
  fingerprintOrchestrationPeer,
  type OrchestrationEnvironmentTransport
} from './runtime/orchestration/environment-transport'
import { callRuntimeEnvironment } from './ipc/runtime-environment-transport-routing'
import { resolveEnvironment } from '../shared/runtime-environment-store'
import { getPreferredPairingOffer } from '../shared/runtime-environments'
import { OrcaRuntimeRpcServer } from './runtime/runtime-rpc'
import {
  recordRuntimeRpcStartFailure,
  showRuntimeRpcStartupFailureDialog
} from './runtime/runtime-rpc-startup-failure'
import { resolveAdvertisedPairingEndpoint } from './runtime/pairing-endpoint'
import { ServeReadinessPublisher } from './server/serve-readiness'
import { reserveServeStdoutForReadiness } from './server/serve-stdout-boundary'
import { DesktopRelayService } from './runtime/relay/desktop-relay-service'
import type { RelayBrokerStatus } from './runtime/relay/relay-session-broker'
import { awaitRuntimeFileWatcherUnsubscribes } from './runtime/orca-runtime-files'
import { clearRuntimeMetadataIfOwned } from './runtime/runtime-metadata'
import { scheduleAllPendingHistoryTreeRemovals } from './terminal-history-deletion'
import { ensureMainI18n, setMainPluginLanguagePacks, setMainUiLanguage } from './i18n/main-i18n'
import {
  getNextDefaultOnAppearanceSettingValue,
  registerAppMenu,
  rebuildAppMenu
} from './menu/register-app-menu'
import { createGpuAccelerationAboutPanelOptions } from './menu/gpu-acceleration-about-panel'
import {
  checkForRemoteServerUpdate,
  checkForUpdatesFromMenu,
  downloadRemoteServerUpdate,
  getRemoteServerUpdaterSnapshot,
  installRemoteServerUpdate,
  isQuittingForUpdate,
  resolveUpdateInstallMode
} from './updater'
import { configureRemoteServerUpdater } from './runtime/remote-server-updater'
import type { UpdateCheckOptions } from '../shared/update-status-types'
import { recordUpdaterLifecycle } from './updater-lifecycle-diagnostics'
import {
  installServeSupervisorDisconnectQuit,
  notifyServeSupervisorReady
} from './serve-update-handoff'
import {
  configureElectronNetworkCompatibility,
  configureDevUserDataPath,
  configureOrcaUserDataPathEnv,
  disableUnsupportedChromiumFeatures,
  optOutOfHiddenPageWakeUpThrottling,
  enableMainProcessGpuFeatures,
  installDevParentDisconnectQuit,
  installDevParentSignalQuit,
  installDevParentWatchdog,
  isDevParentShutdownRequested,
  patchPackagedProcessPath,
  shouldInstallManagedHooks
} from './startup/configure-process'
import {
  installUncaughtPipeErrorGuard,
  installUnhandledRejectionLogging
} from './startup/main-process-error-guards'
import { enableRendererHeapHeadroom } from './startup/renderer-heap-headroom'
import { argvRequestsServeMode, normalizeServeModeArgv } from './startup/serve-mode-argv'
import { ensureVirtualDisplayForHeadlessServe } from './startup/ensure-virtual-display'
import {
  clearGpuFallbackMarker,
  readActiveGpuFallbackMarker,
  writeGpuFallbackMarker,
  type GpuFallbackMarker,
  type GpuFallbackEnvironment,
  type WindowsGpuFallbackEnvironment
} from './startup/gpu-fallback-marker'
import { applyGpuFallbackCommandLineSwitches } from './startup/gpu-fallback-switches'
import {
  DEFAULT_GPU_CRASH_FALLBACK_THRESHOLD,
  DEFAULT_GPU_CRASH_FALLBACK_WINDOW_MS,
  GpuCrashFallbackTracker,
  isGpuFallbackCrashCandidate
} from './crash-reporting/gpu-crash-fallback-decision'
import { promptForGpuFallbackRestart } from './crash-reporting/gpu-fallback-restart-prompt'
import { engageGpuFallbackAfterCrashBurst } from './crash-reporting/gpu-fallback-engagement'
import { GpuCrashDiagnosticsRecorder } from './crash-reporting/gpu-crash-diagnostics'
import {
  handleGpuFallbackRecoveredLaunch,
  promptForGpuFallbackRecoveredLaunch
} from './crash-reporting/gpu-fallback-recovered-launch'
import {
  shouldSuppressDevEducation,
  suppressDevEducationForStore
} from './startup/dev-education-suppression'
import { maybeRedirectAppImageCliLaunch } from './startup/appimage-cli-redirect'
import { maybeRedirectPackagedCliEntryLaunch } from './startup/packaged-cli-entry-redirect'
import { startFirstWindowStartupServices } from './startup/first-window-startup-services'
import { recoverLegacyWorkerTerminalsForRendererStartup } from './startup/legacy-worker-renderer-recovery'
import { createWslCliReconciliationStartupBarrier } from './startup/wsl-cli-reconciliation-startup-barrier'
import { getDevInstanceIdentity, shouldApplyPreReadyAppName } from './startup/dev-instance-identity'
import { hydrateShellPath, mergePathSegments } from './startup/hydrate-shell-path'
import { createWindowsShellPathHydration } from './startup/windows-shell-path-hydration'
import {
  startWindowsDesktopBeforeShellPathReady,
  type WindowsDesktopStartupServices
} from './startup/windows-desktop-shell-path-startup'
import {
  acquireSingleInstanceLock,
  logSingleInstanceLockBypass,
  logSingleInstanceLockFailure,
  shouldActivateDesktopForSecondInstance,
  shouldBypassSingleInstanceLock,
  shouldSkipSingleInstanceLock,
  SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE
} from './startup/single-instance-lock'
import { startEventLoopStallProbe } from './startup/event-loop-stall-probe'
import { startMainThreadChurnProbe } from './diagnostics/main-thread-churn-probe'
import { settledDiffCache } from './git/source-control/git-read-cache-invalidation'
import { parseSkillShareId } from '../shared/skill-share-link'
import { createMacAppActivationHandler } from './window/macos-app-activation'
import {
  normalizeCodexRuntimeSelection,
  type CodexAccountSelectionTarget
} from './codex-accounts/runtime-selection'
import { normalizeClaudeRuntimeSelection } from './claude-accounts/runtime-selection'
import { codexHookService, setSystemCodexHomeHookSweepSuppressed } from './codex/hook-service'
import { reconcileRetainedCodexHookHomes } from './codex/retained-codex-hook-state'
import {
  ensureRealHomeCodexHookState,
  isRealHomeCodexHookLaneUsable
} from './codex/codex-real-home-hook-install'
import { setCodexTrustGrantTelemetry } from './codex/codex-trust-grant-telemetry'
import { startCodexSessionBackfillInBackground } from './codex/codex-session-backfill'
import { startCodexSessionIndexHealInBackground } from './codex/codex-session-index-heal'
import {
  startCodexStateDbBackfillRecoveryInBackground,
  stopCodexStateDbBackfillRecoveries
} from './codex/codex-state-db-backfill-recovery'
import { createCodexSessionMigrationScheduler } from './codex/codex-session-migration-scheduler'
import { prepareCodexAiVaultSessionResume } from './codex/codex-ai-vault-session-resume'
import { prepareLegacySharedCodexSessionResume } from './codex/codex-legacy-session-resume'
import { ManagedCodexHomeTemporarilyUnavailableError } from './codex-accounts/host-codex-managed-home-ownership'
import { resolveHostCodexSessionSourceHome } from './codex/codex-session-source-home'
import type { CodexSessionResumePreparation } from './codex/codex-session-resume-home'
import { prepareCodexSessionResume } from './codex/codex-session-resume-preparation'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex/codex-home-paths'
import { normalizeRuntimePathForComparison } from '../shared/cross-platform-path'
import type { AgentProviderSessionMetadata } from '../shared/agent-session-resume'
import { getDefaultWslDistro } from './wsl'
import { collectWorktreeTrashSweepRoots, sweepStaleWorktreeTrash } from './worktree-trash'
import { ClaudeAccountService } from './claude-accounts/service'
import { ClaudeRuntimeAuthService } from './claude-accounts/runtime-auth-service'
import {
  attachClaudeLivePtyPersistence,
  onLiveClaudePtysDrained,
  seedLiveClaudePtysFromPersistence
} from './claude-accounts/live-pty-gate'
import { StarNagService } from './star-nag/service'
import { agentHookServer, type AgentHookProviderSessionIdentity } from './agent-hooks/server'
import { ingestSessionInfoPlanWindows as ingestPlanWindows } from './fork-session-info/session-info-plan-window-correlation'
import { recordForkPaneTranscriptObservation } from './fork-session-handoff/pane-transcript-history'
import { createHookProviderSessionInvalidator } from './agent-hooks/hook-provider-session-invalidation'
import { createHookStatusSessionTabsInvalidator } from './agent-hooks/hook-status-session-tabs-invalidation'
import { wslHookRelayManager } from './agent-hooks/wsl-hook-relay-manager'
import { maybeAutoRenameBranchOnFirstWork } from './agent-hooks/first-work-branch-rename'
import { rememberBranchRenameFailureOutput } from './agent-hooks/branch-rename-failure-output'
import { renameWorktreeFolderOnFirstWork } from './agent-hooks/first-work-folder-rename'
import { moveWorktree } from './git/worktree'
import {
  configureWindowsHostGitEnvironmentReadiness,
  setDefaultWslDistroOverride
} from './git/runner'
import { getRepoIdFromWorktreeId } from '../shared/worktree/id'
import { parseWorkspaceKey } from '../shared/workspace-scope'
import { setMigrationUnsupportedPtyListener } from './agent-hooks/migration-unsupported-pty-state'
import { AgentBrowserBridge } from './browser/agent-browser-bridge'
import { configureBrowserClientPageAutomationRuntime } from './browser/browser-client-page-automation-runtime'
import { BrowserClientPageCommandError } from './browser/browser-client-page-command-failure'
import { EmulatorBridge } from './emulator/emulator-bridge'
import { browserCertificateTrustController, browserManager } from './browser/browser-manager'
import { RpcDispatcher } from './runtime/rpc/dispatcher'
import { OffscreenBrowserBackend } from './browser/offscreen-browser-backend'
import { browserSessionRegistry } from './browser/browser-session-registry'
import {
  applyBrowserSessionProxies,
  setBrowserNetworkProxySettingsResolver
} from './browser/browser-session-proxy'
import { initializeBrowserSessionsForApp } from './browser/browser-session-startup'
import {
  installDocPreviewProtocolHandler,
  registerDocPreviewSchemePrivileges
} from './browser/doc-preview-protocol'
import { registerDocPreviewGrantHandlers } from './ipc/doc-preview-grant-ipc'
import { initializeBrowserClientHostId } from './browser/browser-client-host-id'
import { setUnreadDockBadgeCount } from './dock/unread-badge'
import { AutomationService } from './automations/service'
import { createHeadlessAutomationOutputSnapshotBuffer } from './automations/headless-dispatch'
import { buildHeadlessAutomationWorktreeCreateArgs } from './automations/headless-workspace-create'
import { createRuntimeAutomationRunTerminalObserver } from './automations/runtime-terminal-run-observer'
import { AgentAwakeService } from './agent-awake-service'
import { normalizeComputerAwakeMode } from '../shared/computer-awake-mode'
import { registerSystemResumeBroadcast } from './system-resume-broadcast'
import { settleTeardownWithinDeadline, settleWithinMs } from './quit-teardown-deadline'
import { stopStructuredAgentSessionRuntime } from './runtime/structured-agent-session-runtime'
import { quitTeardownStartGate } from './quit-teardown-start-gate'
import { beginSshShutdown } from './ipc/ssh-shutdown-drain'
import { PluginService } from './plugins/plugin-service'
import { PluginKillListService } from './plugins/plugin-kill-list-service'
import { getPluginsDataDir } from './plugins/plugin-discovery'
import { PluginMarketplaceService } from './plugins/plugin-marketplace-service'
import { PluginMarketplaceInstaller } from './plugins/plugin-marketplace-installer'
import { PluginBundledBootstrapCoordinator } from './plugins/plugin-bundled-bootstrap-coordinator'
import { resolveBundledPluginRoot } from './plugins/plugin-bundled-bootstrap'
import { resolvePluginHostEntryPath } from './plugins/plugin-host-process'
import { applyPluginConsent, applyPluginEnablement } from './plugins/plugin-enablement'
import { setPluginServiceForRpc } from './runtime/rpc/methods/plugins'
import {
  normalizePluginConsents,
  normalizePluginIdList
} from '../shared/plugins/plugin-consent-state'
import {
  recordCoalescedCrashBreadcrumb,
  recordCrashBreadcrumb
} from './crash-reporting/crash-breadcrumb-store'
import { recordDurableCrashBreadcrumb } from './crash-reporting/durable-crash-breadcrumb'
import { installMainThreadHangWatchdog } from './hang-watchdog/main-thread-hang-watchdog'
import {
  consumeHangDetectionMarker,
  hangDetectionMarkerPath
} from './hang-watchdog/hang-detection-marker'
import { getMainProcessLifecycleIdentity } from './crash-reporting/main-process-lifecycle-identity'
import { CrashReportStore } from './crash-reporting/crash-report-store'
import {
  shouldRecoverRendererAfterProcessGone,
  type ExpectedTeardownScope
} from './crash-reporting/process-gone-classification'
import { recordProcessGoneCrash as recordProcessGoneCrashEvent } from './crash-reporting/process-gone-recorder'
import { startCrashpadCapture } from './crash-reporting/crashpad-capture'
import { startPreGoneProcessMetricsSampling } from './crash-reporting/process-gone-diagnostics'
import { resolveExpectedTeardownScope } from './crash-reporting/expected-teardown-state'
import {
  advanceSyntheticTitleSpinnerEntries,
  getSyntheticTitleSpinnerPaneKeyToStop,
  type SyntheticTitleSpinnerEntry
} from './synthetic-title-spinner'
import { shouldSendSyntheticTitleFrame } from './synthetic-title-visibility'
import { shouldCopySyntheticTitleFrameToPtyData } from './synthetic-title-frame-routing'
import {
  getSyntheticAgentTitleProfile,
  shouldDriveSyntheticAgentTitleFromHook,
  type SyntheticAgentTitleProfile
} from '../shared/synthetic-agent-title'
import type { AgentStatusState } from '../shared/agent-status-types'
import { resolveTuiAgentPermissionMode } from '../shared/tui-agent-permissions'
import { isAskUserQuestionTool } from '../shared/agent-question-answered-intent'
import type { TerminalSideEffectBatch } from '../shared/terminal-side-effect-facts'
import {
  HEADLESS_RUNTIME_WINDOW_ID,
  type RuntimeDesktopWindowStatus
} from '../shared/runtime-types'
import { LocalPtyProvider } from './providers/local-pty-provider'
import { KeybindingService } from './keybindings/keybinding-service'
import {
  applyElectronProxySettings,
  setDefaultProxySessionResolver
} from './network/proxy-settings'
import { handleElectronProxyLogin } from './network/electron-proxy-credentials'
import { installElectronProxyRequestGuard } from './network/electron-proxy-request-guard'
import { preserveAgentAuthBeforeRestart } from './agent-auth-restart-preservation'
import { CliInstaller } from './cli/cli-installer'
import { installLinuxBareOrcaDispatcher } from './cli/linux-bare-orca-dispatcher'
import { reconcileManagedWslCliRegistrations } from './cli/wsl-cli-registration-reconciliation'

function openMainWindow(options: { revealOnDidFinishLoad?: boolean } = {}): BrowserWindow {
  return openMainWindowController(options)
}

setMainWindowOpener(openMainWindow)

function focusExistingWindow(): void {
  focusExistingWindowAction()
}

function requestDesktopActivation(argv: readonly string[] = []): void {
  state.skillShareDeepLinks.capture(argv, (shareId) => {
    state.mainWindow?.webContents.send('ui:openSkillShare', shareId)
  })
  state.osOpenedMarkdownFiles.capture(argv, publishOsOpenedMarkdownFiles)
  // Why: a duplicate `orca serve` must not drag a headless server into opening a desktop window (#11935).
  if (!shouldActivateDesktopForSecondInstance(argv)) {
    return
  }
  state.desktopActivationGate?.requestActivation()
}

/**
 * Hands buffered OS-opened markdown paths to a renderer that has proven it is listening.
 *
 * Until that proof arrives the paths stay buffered, because `webContents.send` to a renderer
 * with no listener attached is dropped silently and the queue would be gone.
 */
function publishOsOpenedMarkdownFiles(): void {
  const targetWindow = state.mainWindow
  if (!state.markdownFileOpenListenerReady || !targetWindow || targetWindow.isDestroyed()) {
    return
  }
  // Why consumed before the await: a renderer pull racing this resolve must not take the same
  // batch again. The restore() calls hand it back if delivery turns out to be impossible.
  const filePaths = state.osOpenedMarkdownFiles.consume()
  if (filePaths.length === 0) {
    return
  }
  void resolveOpenedMarkdownDocuments(filePaths)
    .then((documents) => {
      if (targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
        state.osOpenedMarkdownFiles.restore(filePaths)
        return
      }
      if (documents.length > 0) {
        targetWindow.webContents.send('ui:openMarkdownFiles', documents)
      }
    })
    .catch((error) => {
      state.osOpenedMarkdownFiles.restore(filePaths)
      console.warn('[os-open] Failed to resolve OS-opened markdown files:', error)
    })
}

const handleMacAppActivation = createMacAppActivationHandler({
  getWindow: () => state.mainWindow,
  requestActivation: requestDesktopActivation
})

const preflightReady = runMainProcessPreflight({
  focusExistingWindow,
  requestDesktopActivation
})

// Why: when another process holds the lock we've already exited; skip file-writing side effects so this transient process never touches userData.
if (preflightReady) {
  app.on('open-url', (event, url) => {
    if (!parseSkillShareId(url)) {
      return
    }
    event.preventDefault()
    requestDesktopActivation([url])
  })
  // Why: macOS delivers "Open With" as open-file, often before `ready`, and only to a handler
  // that claims the event. Non-markdown paths stay unclaimed so the OS default handler wins.
  app.on('open-file', (event, filePath) => {
    if (!state.osOpenedMarkdownFiles.captureFilePaths([filePath], publishOsOpenedMarkdownFiles)) {
      return
    }
    event.preventDefault()
    // Why gated on isReady: pre-ready the cold-start window is already on its way, and
    // activating the gate here would try to open one before Electron can.
    if (app.isReady()) {
      requestDesktopActivation()
    }
  })
  state.skillShareDeepLinks.capture(process.argv)
  // Why no publish: nothing is listening this early, so the first renderer pulls these on mount.
  state.osOpenedMarkdownFiles.capture(process.argv)
  registerMainProcessIpcHandlers()
  installMainProcessQuitHandlers()
  void app.whenReady().then(async () => {
    await initializeMainProcessReady({
      openMainWindow,
      handleMacAppActivation
    })
  })
  // Why: the error-tracking lane (telemetry-error-tracking.md) is its own
  // composition root — independent of product telemetry — and must
  // initialize before any IPC handler / runtime span is created so the
  // tracer's active sink is populated at the moment the first span fires.
  // Honors DO_NOT_TRACK / ORCA_TELEMETRY_DISABLED / ORCA_DIAGNOSTICS_DISABLED
  // / CI internally; those gates do not need to be re-checked here.
  initObservability()
  recordDurableCrashBreadcrumb('main_process_lifecycle_started', {
    packaged: app.isPackaged,
    platform: process.platform
  })
  const skillTransactionRecovery = recoverPendingSkillTransactions(
    join(app.getPath('userData'), 'skill-installs')
  )
  void skillTransactionRecovery
    .then((report) => {
      if (report.scanned || report.failures.length || report.truncated) {
        console.info('[skills] startup transaction recovery:', {
          scanned: report.scanned,
          recovered: report.recovered,
          failures: report.failures.map((failure) => failure.code),
          truncated: report.truncated
        })
      }
    })
    .catch((error) => console.warn('[skills] startup transaction recovery failed:', error))
  // Why: cohort-classifier reads repo count synchronously at every emit, so hydrate it here — before any IPC handler or window can trigger track().
  initCohortClassifier(store)
  initOnboardingCohortClassifier(store)
  stats = new StatsCollector()
  // Agent-session stats come from hook status transitions, the same truth the
  // sidebar and dashboard read — never from OSC terminal titles, which miss
  // hook-only agents and count any spinner TUI as an agent (#10201).
  const agentSessionRecorder = new AgentSessionTransitionRecorder(stats)
  agentHookServer.subscribeEnrichedStatus((enriched) => {
    agentSessionRecorder.onStatus(enriched)
  })
  agentHookServer.subscribeEnrichedStatus(recordForkPaneTranscriptObservation)
  agentHookServer.subscribePaneStatusClear((clear) => {
    agentSessionRecorder.onCleared(clear)
  })
  claudeUsage = new ClaudeUsageStore(store)
  codexUsage = new CodexUsageStore(store)
  openCodeUsage = new OpenCodeUsageStore(store)
  rateLimits = new RateLimitService()
  codexRuntimeHome = new CodexRuntimeHomeService(store)
  void startCodexStateDbBackfillRecoveryInBackground(getOrcaManagedCodexHomePath())
  // Why: an incapable trust-grant host must fall back to the managed home for
  // every consumer (PTY env, rate limits, commit messages) in one place.
  codexRuntimeHome.setRealHomeLaneGate(() => isRealHomeCodexHookLaneUsable())
  // Why: while the real-home lane owns ~/.codex/hooks.json, the legacy
  // system-home sweep inside managed installs would delete the entry the
  // real-home installer just appended. Flag OFF, hooks off, or an incapable
  // trust lane re-arms the sweep so downgrade, opt-out, and rollback converge.
  setSystemCodexHomeHookSweepSuppressed(
    () =>
      codexRuntimeHome !== null &&
      codexRuntimeHome.isHostSystemDefaultRealHome() &&
      isAgentStatusHooksEnabled(store?.getSettings())
  )
  codexSessionMigration = createCodexSessionMigrationScheduler({
    isEligible: () => codexRuntimeHome?.isHostSystemDefaultSessionMigrationEligible() === true,
    isQuitting: () => isQuitting,
    resolveSystemCodexHomePathOverride: () =>
      resolveHostCodexSessionSourceHome(store!.getSettings()),
    prepareScheduledRun: (scanDates) =>
      codexRuntimeHome?.prepareHostSystemDefaultSessionMigrationPass(scanDates),
    finishScheduledRun: () => codexRuntimeHome?.finishHostSystemDefaultSessionMigrationPass(),
    startBackfill: startCodexSessionBackfillInBackground,
    startIndexHeal: startCodexSessionIndexHealInBackground
  })
  codexAccounts = new CodexAccountService(store, rateLimits, codexRuntimeHome, {
    onHostSystemDefaultSelected: codexSessionMigration.requestRun
  })
  // Why: migrate historical shared-home sessions after startup; compatibility
  // launches re-arm the non-destructive pass for new rollouts (#4444, #8612, #12480).
  codexSessionMigration.scheduleInitialRun()
  claudeRuntimeAuth = new ClaudeRuntimeAuthService(store)
  claudeAccounts = new ClaudeAccountService(store, rateLimits, claudeRuntimeAuth)
  rateLimits.setCodexHomePathResolver((target) =>
    codexRuntimeHome!.prepareForRateLimitFetch(target)
  )
  rateLimits.setCodexFetchTarget(getInitialCodexRateLimitTarget(store.getSettings()))
  // Why: Kimi's CLI refreshes its OAuth token in whichever runtime it runs in, so the
  // usage fetch must read the WSL-side credentials when that's the configured runtime (#12370).
  rateLimits.setKimiHomeResolver(() => resolveKimiHome(getKimiRuntimeTarget(store!.getSettings())))
  rateLimits.setClaudeFetchTarget(getInitialClaudeRateLimitTarget(store.getSettings()))
  const syncAccountRuntimeTargets = createAccountRuntimeTargetSettingsSync(
    rateLimits,
    store.getSettings()
  )
  store.onSettingsChanged((updates, settings) => {
    // Why: auto is a live policy; retarget only providers whose settings-derived runtime changed.
    void syncAccountRuntimeTargets(updates, settings).catch((error) =>
      console.warn('[rate-limits] Failed to apply account runtime target:', error)
    )
  })
  rateLimits.setClaudeAuthPreparationResolver((target) =>
    claudeRuntimeAuth!.prepareForRateLimitFetch(target)
  )
  // Why: live Claude sessions stream usage windows through their statusLine command; feeding them here avoids OAuth usage-endpoint polling (and its 429s).
  agentHookServer.setClaudeStatusLineListener((event) => ingestPlanWindows(rateLimits, event))
  rateLimits.setOpenCodeGoConfigResolver(() => {
    const settings = store!.getSettings()
    return {
      sessionCookie: settings.opencodeSessionCookie,
      workspaceIdOverride: settings.opencodeWorkspaceId
    }
  })
  rateLimits.setMiniMaxConfigResolver(() => {
    const settings = store!.getSettings()
    return {
      sessionCookie: readMiniMaxSessionCookie() ?? '',
      groupId: settings.minimaxGroupId,
      models: settings.minimaxUsageModels
    }
  })
  rateLimits.setGeminiCliOAuthEnabledResolver(() => store!.getSettings().geminiCliOAuthEnabled)
  rateLimits.setNetworkProxySettingsResolver(() => store!.getSettings())
  keybindings = new KeybindingService({
    homePath: app.getPath('home'),
    getLegacyOverrides: () => store!.getSettings().keybindings,
    legacyTabSwitchSeed: {
      isPending: () => store!.getSettings().tabSwitchKeybindingSeed === 'pending',
      markSeeded: () => {
        store!.updateSettings({ tabSwitchKeybindingSeed: 'done' })
      }
    }
  })
  browserManager.setSettingsResolver(() => ({ keybindings: keybindings?.getOverrides() }))
  rateLimits.setInactiveClaudeAccountsResolver(() => {
    const settings = store!.getSettings()
    const activeIds = new Set(
      [
        normalizeClaudeRuntimeSelection(settings).host,
        ...Object.values(normalizeClaudeRuntimeSelection(settings).wsl)
      ].filter(Boolean)
    )
    return settings.claudeManagedAccounts
      .filter((account) => !activeIds.has(account.id))
      .map((account) => ({
        id: account.id,
        managedAuthPath: account.managedAuthPath,
        managedAuthRuntime: account.managedAuthRuntime,
        wslDistro: account.wslDistro,
        wslLinuxAuthPath: account.wslLinuxAuthPath
      }))
  })
  rateLimits.setInactiveCodexAccountsResolver(() => {
    const settings = store!.getSettings()
    const activeIds = new Set(
      [
        normalizeCodexRuntimeSelection(settings).host,
        ...Object.values(normalizeCodexRuntimeSelection(settings).wsl)
      ].filter(Boolean)
    )
    return settings.codexManagedAccounts
      .filter((account) => !activeIds.has(account.id))
      .map((account) => ({
        id: account.id,
        resolveHome: () => {
          const resolved = codexRuntimeHome!.resolveCodexManagedAccountHomeForInactiveFetch(account)
          return resolved.kind === 'ready'
            ? { kind: 'ready' as const, managedHomePath: resolved.homePath }
            : { kind: 'skip' as const }
        }
      }))
  })
  const orchestrationEnvironmentTransport: OrchestrationEnvironmentTransport = {
    resolve: (selector) => {
      const environment = resolveEnvironment(app.getPath('userData'), selector)
      const pairing = getPreferredPairingOffer(environment)
      return {
        environmentId: environment.id,
        name: environment.name,
        peerFingerprint: fingerprintOrchestrationPeer(pairing.publicKeyB64)
      }
    },
    call: (selector, method, params, timeoutMs, envelope) =>
      callRuntimeEnvironment(
        app.getPath('userData'),
        selector,
        method,
        params,
        timeoutMs,
        undefined,
        envelope
      )
  }
  const runtimeService = new OrcaRuntimeService(store, stats, {
    agentSessionClaimSigner: loadAgentSessionClaimSigner(
      getProfileUserDataPath(),
      getProfileUserDataPath()
    ),
    // Why: resolve the PTY provider lazily — a daemon swap happens later, so an eager reference would freeze the pre-daemon provider (design §4.3).
    getLocalProvider: () => getLocalPtyProvider(),
    // Why: SSH relay providers register after construction and may reconnect, so destructive cleanup must resolve the current generation.
    getSshProvider: (connectionId) => getSshPtyProvider(connectionId),
    onPtyStopped: clearProviderPtyState,
    onTerminalAgentStatus: (event) => {
      agentHookServer.ingestTerminalStatus(event)
    },
    // Why: serve can be promoted in place, so wire the listener from startup; runtime enables desktop-only scanners only for a ready renderer.
    onTerminalSideEffects: (batch: TerminalSideEffectBatch) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('pty:sideEffect', batch)
      }
    },
    getDesktopWindowStatus: getDesktopWindowStatus,
    // Why: worktree.ps pulls hook-reported agent status (same source as the desktop sidebar) at query time so mobile shows the same agents.
    getAgentStatusSnapshot: () =>
      agentHookServer.getStatusSnapshot().filter((entry) => entry.providerSessionOnly !== true),
    // Why: the filter above hides resume-identity rows from the live-agent views, but
    // those rows carry the provider session mobile native chat addresses transcripts
    // by — Pi publishes identity that way and would otherwise be unreachable.
    getAgentProviderSessionSnapshot: () => agentHookServer.getStatusSnapshot(),
    getAgentProviderSessionRowsForPane: (paneKey) =>
      agentHookServer.getStatusSnapshotForPane(paneKey),
    attestAgentHookCompatibilityAuthority: (candidate) =>
      agentHookServer.attestCompatibilityAuthority(candidate),
    retireAgentHookCompatibilityAuthority: (paneKey) =>
      agentHookServer.retirePaneAuthority(paneKey),
    reconcileAgentStatusForEndedProcess: (paneKeys) => {
      agentHookServer.reconcileEndedProcessForPaneKeys(paneKeys)
    },
    canRecoverPersistentLocalPtys: () => getDaemonProvider() !== null,
    // Why: evaluated per call, not captured — the RPC server that owns the device registry is
    // constructed with this runtime and does not exist yet at this point.
    getPairedDeviceName: (pairedDeviceId) =>
      runtimeRpc?.getDeviceRegistry()?.getDevice(pairedDeviceId)?.name ?? null,
    // Why: source codex-home here (runs in window AND serve) so aiVault.listSessions includes managed-Codex sessions; registerCoreHandlers is window-only.
    getAdditionalAiVaultCodexHomePaths: () =>
      codexRuntimeHome ? codexRuntimeHome.getHostCodexHomePathsForSessionDiscovery() : [],
    prepareAiVaultSessionResume: (args) =>
      prepareCodexAiVaultSessionResume(args, {
        runtimeHome: codexRuntimeHome,
        systemCodexHomePath: resolveHostCodexSessionSourceHome(store!.getSettings())
      }),
    prepareCodexStructuredLaunch: ({ workspacePath, launchEnv }) =>
      prepareCodexRuntimeHomeForLaunch(undefined, launchEnv, {
        launchAgent: 'codex',
        workspacePath
      }),
    buildAgentHookPtyEnv: () =>
      isAgentStatusHooksEnabled(store?.getSettings()) ? agentHookServer.buildPtyEnv() : {},
    orchestrationEnvironmentTransport,
    skillTransactionRecovery
  })
  runtime = runtimeService
  runtimeService.prepareLegacyWorkerTerminalRecovery()
  // Why before anything can attach: a client host that reattaches to a restarted runtime is only
  // handed its pages back if the runtime found them first.
  runtimeService.rehydrateClientHostedBrowserPages()
  publishProviderSessionChanges(agentHookServer.getProviderSessionIdentities())
  browserManager.setBrowserGuestStateChangedListener((worktreeId) => {
    runtimeService.notifyMobileSessionTabsChanged(worktreeId)
  })
  automations = new AutomationService(store, {
    claudeUsage,
    codexUsage,
    terminalObserver: createRuntimeAutomationRunTerminalObserver(runtimeService),
    onAutomationsChanged: (payload) => runtimeService.notifyAutomationsChanged(payload),
    // Why: desktop clients mirror remote-host automations, but only a server process should execute remote_host_service-owned schedules.
    allowRemoteHostScheduling: isServeMode,
    headlessDispatcher: isServeMode
      ? async ({ automation, run, target }) => {
          const terminalSnapshotLimit = 2_000
          let terminalHandle: string
          let terminalSessionId: string | null = null
          let terminalPaneKey: string | null = null
          let terminalPtyId: string | null = null
          let workspaceId: string
          let workspaceDisplayName: string | null = null

          if (automation.workspaceMode === 'new_per_run') {
            const created = await runtimeService.createManagedWorktree({
              ...buildHeadlessAutomationWorktreeCreateArgs({
                automation,
                run,
                repo: target.repo
              })
            })
            terminalHandle = created.startupTerminal?.handle ?? ''
            terminalSessionId = created.startupTerminal?.tabId ?? null
            terminalPaneKey = created.startupTerminal?.paneKey ?? null
            terminalPtyId = created.startupTerminal?.ptyId ?? null
            workspaceId = created.worktree.id
            workspaceDisplayName = created.worktree.displayName ?? null
            if (!terminalHandle) {
              throw new Error(
                created.warning ||
                  'Automation workspace was created, but no agent terminal started.'
              )
            }
          } else {
            if (!automation.workspaceId) {
              throw new Error('The target workspace is no longer available.')
            }
            const terminal = await runtimeService.launchAgentTerminal(
              `id:${automation.workspaceId}`,
              {
                agent: automation.agentId,
                prompt: automation.prompt,
                title: run.title
              }
            )
            terminalHandle = terminal.handle
            terminalSessionId = terminal.tabId ?? null
            terminalPaneKey = terminal.paneKey ?? null
            terminalPtyId = terminal.ptyId ?? null
            workspaceId = terminal.worktreeId
            const worktree = await runtimeService.showManagedWorktree(`id:${workspaceId}`)
            workspaceDisplayName = worktree.displayName ?? null
          }

          const completion = (async () => {
            const wait = await runtimeService.waitForTerminal(terminalHandle, {
              condition: 'tui-idle'
            })
            const read = await runtimeService.readTerminal(terminalHandle, {
              limit: terminalSnapshotLimit
            })
            const snapshotBuffer = createHeadlessAutomationOutputSnapshotBuffer()
            snapshotBuffer.append(read.tail.join('\n'))
            if (wait.satisfied) {
              return {
                status: 'completed' as const,
                outputSnapshot: snapshotBuffer.snapshot(),
                error: null
              }
            }
            return {
              status: 'dispatch_failed' as const,
              outputSnapshot: snapshotBuffer.snapshot(),
              error: wait.blockedReason
                ? `Automation agent is blocked: ${wait.blockedReason}.`
                : 'Automation agent did not report completion.'
            }
          })()

          return {
            workspaceId,
            workspaceDisplayName,
            terminalSessionId,
            terminalPaneKey,
            terminalPtyId,
            completion
          }
        }
      : undefined
  })
  runtimeService.setAutomationService(automations)
  runtimeService.setArtifactService(
    new ArtifactCloudService(app.getPath('userData'), () =>
      isArtifactSharingEnabled(store?.getSettings())
    )
  )
  runtimeService.setSkillCloudService(new SkillCloudService(app.getPath('userData')))
  runtimeService.setAccountServices({ claudeAccounts, codexAccounts, rateLimits })
  runtimeService.setCommitMessageAgentEnvironmentResolvers({
    // Why: Codex hooks/auth live in Orca's managed runtime home even for the default path, so every launch must resolve CODEX_HOME via runtime-home.
    prepareForCodexLaunch: prepareCodexRuntimeHomeForLaunch,
    prepareForClaudeLaunch: (target) => claudeRuntimeAuth!.prepareForClaudeLaunch(target)
  })
  const pluginSystemStartupStartedAt = performance.now()
  pluginKillListService = new PluginKillListService({
    pluginsDataDir: getPluginsDataDir(app.getPath('userData'))
  })
  await pluginKillListService.initialize()
  pluginMarketplaceService = new PluginMarketplaceService({
    pluginsDataDir: getPluginsDataDir(app.getPath('userData')),
    getKillListEntry: (pluginKey) => pluginKillListService?.find(pluginKey) ?? null
  })
  const requestOfficialMarketplaceSeed = (): void => {
    if (store?.getSettings().pluginSystemEnabled !== true) {
      return
    }
    void pluginMarketplaceService?.seedOfficialSource().catch((error) => {
      console.warn('[plugins] failed to configure the official marketplace:', error)
    })
  }
  pluginMarketplaceInstaller = new PluginMarketplaceInstaller({
    marketplace: pluginMarketplaceService,
    userDataPath: app.getPath('userData'),
    hostVersion: app.getVersion(),
    blockedPluginReason: (pluginKey) => pluginKillListService?.reason(pluginKey) ?? null
  })
  pluginService = new PluginService({
    userDataPath: app.getPath('userData'),
    hostVersion: app.getVersion(),
    // Feature flag: with the setting off, discovery returns nothing and no
    // plugin code path runs at all.
    isPluginSystemEnabled: () => store?.getSettings().pluginSystemEnabled === true,
    getDisabledPlugins: () => normalizePluginIdList(store?.getSettings().disabledPlugins),
    getPluginConsents: () => normalizePluginConsents(store?.getSettings().pluginConsents),
    getDevPluginPaths: () => normalizePluginIdList(store?.getSettings().devPluginPaths),
    getKeybindings: () => keybindings?.getOverrides() ?? {},
    getPluginKillListEntry: (pluginKey) => pluginKillListService?.find(pluginKey) ?? null,
    hostEntryPath: resolvePluginHostEntryPath(app.getAppPath(), app.isPackaged)
  })
  const bundledPluginBootstrap = new PluginBundledBootstrapCoordinator({
    root: resolveBundledPluginRoot({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath()
    }),
    userDataPath: app.getPath('userData'),
    hostVersion: app.getVersion(),
    isEnabled: () => store?.getSettings().pluginSystemEnabled === true,
    blockedPluginReason: (pluginKey) => pluginKillListService?.reason(pluginKey) ?? null,
    refreshPlugins: () => pluginService?.refresh() ?? Promise.resolve()
  })
  const requestBundledPluginBootstrap = (): void => {
    void bundledPluginBootstrap
      .request()
      .then((result) => {
        for (const failure of result?.errors ?? []) {
          console.warn(`[plugins] failed to publish bundled ${failure.pluginKey}:`, failure.error)
        }
      })
      .catch((error) => {
        console.warn('[plugins] failed to bootstrap bundled plugins:', error)
      })
  }
  pluginKillListService.onChanged(() => {
    void pluginService?.reconcileActivationState().catch((error) => {
      console.warn('[plugins] failed to apply plugin safety-list refresh:', error)
    })
  })
  store.onSettingsChanged((updates) => {
    if (updates.pluginSystemEnabled === true) {
      requestBundledPluginBootstrap()
      requestOfficialMarketplaceSeed()
    }
    if (app.isPackaged && updates.pluginSystemEnabled === true) {
      void pluginKillListService?.refresh().catch((error) => {
        console.warn('[plugins] failed to refresh plugin safety list; using cached state:', error)
      })
    }
  })
  // Why: headless `orca serve` clients reach plugins through the runtime RPC
  // methods, which resolve the service via this module-level setter. Consent
  // over RPC uses the same hash-keyed write path as the desktop dialog.
  setPluginServiceForRpc(pluginService, {
    applyConsent: (request) =>
      applyPluginConsent({ store: store!, pluginService: pluginService!, ...request }),
    applyEnablement: (pluginKey, enabled) =>
      applyPluginEnablement({ store: store!, pluginService: pluginService!, pluginKey, enabled })
  })
  // Lazy kernel: initialize() only discovers manifests — no worker forks, no
  // panel reads. Zero plugin code runs before an explicit trigger.
  void pluginService
    .initialize()
    .then(() => {
      logStartupMilestone('plugin-system-initialized', {
        durationMs: Number((performance.now() - pluginSystemStartupStartedAt).toFixed(2)),
        installedPlugins: pluginService?.getDiscovered().length ?? 0
      })
    })
    .catch((error) => {
      console.warn('[plugins] failed to initialize plugin service:', error)
    })
  if (app.isPackaged && store?.getSettings().pluginSystemEnabled === true) {
    void pluginKillListService.refresh().catch((error) => {
      console.warn('[plugins] failed to refresh plugin safety list; using cached state:', error)
    })
  }
  pluginService.onChanged((event) => {
    if (
      event.contentPacksChanged &&
      setMainPluginLanguagePacks(pluginService?.contentPacks.languagePacks.list() ?? [])
    ) {
      void setMainUiLanguage(store!.getSettings().uiLanguage).then(() => rebuildAppMenu())
    }
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send('plugins:changed', event)
      }
    }
  })
  requestBundledPluginBootstrap()
  requestOfficialMarketplaceSeed()
  // v0 plugin event seams: agent status (hook pipeline tap) + worktree
  // lifecycle (runtime tap). Server-side filtered per plugin subscription.
  agentHookServer.subscribeEnrichedStatus((enriched) => {
    // Why: plugins may automate on `working`; restored rows are historical claims, not fresh activity.
    if (enriched.restoredUnconfirmed) {
      return
    }
    pluginService?.emitEvent('agent.status.changed', {
      worktreeId: enriched.worktreeId ?? null,
      paneKey: enriched.paneKey,
      state: enriched.payload.state,
      receivedAt: enriched.receivedAt
    })
  })
  runtimeService.onWorktreeLifecycle((event) => {
    emitPluginWorktreeLifecycle(event)
  })
  starNag = new StarNagService(store, stats)
  starNag.start()
  starNag.registerIpcHandlers()
  const agentBrowserBridge = new AgentBrowserBridge(browserManager, {
    onTabsChanged: (worktreeId) => runtimeService.notifyMobileSessionTabsChanged(worktreeId)
  })
  runtimeService.setAgentBrowserBridge(agentBrowserBridge)
  // Why: daemons a crashed or SIGKILL'd previous run left behind answer to nobody; nothing else reclaims them.
  void agentBrowserBridge.sweepOrphanedSessions()
  const browserClientAutomationDispatcher = new RpcDispatcher({ runtime: runtimeService })
  configureBrowserClientPageAutomationRuntime({
    browserManager,
    getAgentBrowserBridge: () => agentBrowserBridge,
    executeRpc: async (method, params, signal) => {
      const response = await browserClientAutomationDispatcher.dispatch(
        {
          id: randomUUID(),
          authToken: 'local-browser-client-automation',
          method,
          params
        },
        { signal }
      )
      if (!response.ok) {
        throw new BrowserClientPageCommandError(response.error.code)
      }
      return response.result
    }
  })

  // Emulator bridge (serve-sim). macOS-only feature (gated in CLI/runtime); always ship like agent-browser.
  // Why: externally started serve-sim processes must stay independent — only Orca-managed/attached helpers belong to a workspace.
  const emulatorBridge = new EmulatorBridge()
  runtimeService.setEmulatorBridge(emulatorBridge)
  // Why: worktree deletion renames the checkout aside and deletes it in the background, so a quit or
  // crash mid-delete can leave the moved directory on disk.
  void sweepStaleWorktreeTrash(
    collectWorktreeTrashSweepRoots(store.getRepos(), store.getSettings())
  ).catch((error) => {
    console.warn('[worktrees] Failed to sweep leftover worktree directories:', error)
  })
  nativeTheme.themeSource = store.getSettings().theme ?? 'system'
  // Why (#16441): the real-home grant runs a codex app-server session. It stays
  // ordered before managed-hook reconciliation — an incapable host must re-arm
  // and complete the legacy real-home sweep first — but awaiting it inline
  // stalled app init behind that session, so chain instead of blocking.
  const startupManagedHookSettings = store.getSettings()
  const shouldReconcileStartupManagedHooks =
    shouldInstallManagedHooks(is.dev) &&
    resolveStartupManagedHookAction(startupManagedHookSettings) === 'install'
  const realHomeCodexHookState =
    shouldReconcileStartupManagedHooks &&
    shouldInstallStartupManagedAgentHook(startupManagedHookSettings, 'codex') &&
    codexRuntimeHome.isHostSystemDefaultRealHomeSelected()
      ? ensureRealHomeCodexHookState({
          hooksEnabled: true,
          userDataPath: app.getPath('userData')
        }).catch((error: unknown) => {
          console.warn('[codex-real-home-hooks] startup ensure failed:', error)
        })
      : Promise.resolve()
  // Why skip rather than remove when the off switch is set: the hook files are user-global but this
  // decision reads only THIS profile's settings, so removing here deletes the hooks every other Orca
  // instance depends on (STA-5679). Skipping already keeps removed hooks from reappearing on launch.
  if (shouldReconcileStartupManagedHooks) {
    const managedHookStore = store
    void realHomeCodexHookState
      .then(() =>
        installManagedAgentHooks(managedHookStore.getSettings(), {
          shouldHydrateShellPath: app.isPackaged,
          onInstallError: recordManagedHookInstallFailure,
          shouldContinue: (agent) => {
            const settings = managedHookStore.getSettings()
            return shouldContinueManagedHookStartup(isQuitting, settings, agent)
          }
        })
      )
      .catch((error: unknown) => {
        console.warn('[agent-hooks] failed to reconcile managed hooks on startup:', error)
      })
  }
  // Why: process-gone metrics only see survivors; retain a recent whole-app
  // snapshot for comparison in crash reports.
  startPreGoneProcessMetricsSampling()
  app.on('child-process-gone', (_event, details) => {
    recordProcessGoneCrash('child', details.type, details.reason, details.exitCode ?? null, {
      name: details.name,
      serviceName: details.serviceName,
      type: details.type
    })
    if (
      isGpuFallbackCrashCandidate({
        platform: process.platform,
        processType: details.type,
        reason: details.reason
      })
    ) {
      const crashedAt = performance.now()
      void gpuCrashDiagnostics?.record()
      void handleGpuChildCrash(details.reason, details.exitCode ?? null, crashedAt)
    }
  })

  logStartupMilestone('services-initialized')
  await ensureMainI18n()
  await setMainUiLanguage(store.getSettings().uiLanguage)
  logStartupMilestone('i18n-ready')

  registerAppMenu({
    appMenuLabel: devInstanceIdentity.name,
    onCheckForUpdates: (options) => runUserInitiatedUpdateCheck(options),
    onBeforeReload: ({ ignoreCache, webContentsId }) => {
      if (mainWindow?.webContents.id === webContentsId) {
        markExpectedRendererReload(webContentsId)
      }
      recordCrashBreadcrumb('manual_reload_requested', { ignoreCache })
    },
    onOpenSettings: openSettingsFromSystemMenu,
    onOpenSetupGuide: (targetWindow) => {
      recordCrashBreadcrumb('setup_guide_opened')
      const targetBrowserWindow = targetWindow instanceof BrowserWindow ? targetWindow : null
      sendOpenSetupGuide(targetBrowserWindow)
    },
    onOpenCrashReport: (targetWindow) => {
      recordCrashBreadcrumb('crash_report_opened')
      const targetBrowserWindow = targetWindow instanceof BrowserWindow ? targetWindow : null
      sendOpenCrashReport(targetBrowserWindow)
    },
    onOpenFeatureTour: (targetWindow) => {
      recordCrashBreadcrumb('feature_tour_opened')
      // Why: use the invoking BrowserWindow so hidden/E2E and multi-window flows route to the right renderer, not global focus.
      const targetBrowserWindow = targetWindow instanceof BrowserWindow ? targetWindow : null
      sendOpenFeatureTour(targetBrowserWindow)
    },
    // Why: menu zoom must act on the window the user is looking at — routing to
    // the main window while the dashboard pop-out is focused zooms behind it.
    onZoomIn: () => {
      if (!zoomDashboardPopoutIfFocused('in')) {
        mainWindow?.webContents.send('terminal:zoom', 'in')
      }
    },
    onZoomOut: () => {
      if (!zoomDashboardPopoutIfFocused('out')) {
        mainWindow?.webContents.send('terminal:zoom', 'out')
      }
    },
    onZoomReset: () => {
      if (!zoomDashboardPopoutIfFocused('reset')) {
        mainWindow?.webContents.send('terminal:zoom', 'reset')
      }
    },
    onToggleLeftSidebar: () => {
      mainWindow?.webContents.send('ui:toggleLeftSidebar')
    },
    onToggleRightSidebar: () => {
      mainWindow?.webContents.send('ui:toggleRightSidebar')
    },
    onToggleAppearance: (key) => {
      if (!store) {
        return
      }
      if (key === 'statusBarVisible') {
        // Why: status bar visibility lives in persisted UI state (not settings) and the renderer owns the toggle — forward the event, let it flip + store.
        mainWindow?.webContents.send('ui:toggleStatusBar')
        return
      }
      const current = store.getSettings()
      // Why: these appearance settings are default-on, so a missing persisted value must toggle from visible -> hidden.
      const next = getNextDefaultOnAppearanceSettingValue(current[key])
      store.updateSettings({ [key]: next }, { notifyListeners: true })
      rebuildAppMenu()
    },
    getAppearanceState: () => {
      const settings = store?.getSettings()
      const ui = store?.getUI()
      return {
        showTasksButton: settings?.showTasksButton !== false,
        showAutomationsButton: settings?.showAutomationsButton !== false,
        showMobileButton: settings?.showMobileButton !== false,
        showTitlebarAppName: settings?.showTitlebarAppName !== false,
        statusBarVisible: ui?.statusBarVisible !== false
      }
    },
    getKeybindings: () => keybindings?.getOverrides()
  })
  // Why: parallel E2E Electron instances would race the fixed port (EADDRINUSE); port 0 gives each a random OS-assigned port.
  const isE2E = Boolean(process.env.ORCA_E2E_USER_DATA_DIR)
  const requestedE2EWsPort = process.env.ORCA_E2E_RUNTIME_WS_PORT
  const e2eWsPort = requestedE2EWsPort === undefined ? 0 : Number(requestedE2EWsPort)
  if (isE2E && (!Number.isInteger(e2eWsPort) || e2eWsPort < 0 || e2eWsPort > 65_535)) {
    throw new Error(`Invalid ORCA_E2E_RUNTIME_WS_PORT value: ${requestedE2EWsPort}`)
  }
  // Why: pin dev to 6769 so `pnpm dev` doesn't race packaged Orca on 6768 and fall back to a random port, breaking deterministic mobile pairing/repro (STA-1511).
  const devWsPort = is.dev && !isE2E ? 6769 : undefined
  let serveOptions: ServeOptions | null = null
  try {
    serveOptions = isServeMode ? getServeOptions() : null
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    app.exit(1)
    return
  }
  // Why: existing installs may have pairing creds under the late app.getPath('userData'); copy them forward before switching to the canonical path.
  migrateMobilePairingDataToCanonicalUserDataPath(app.getPath('userData'))
  runtimeRpc = new OrcaRuntimeRpcServer({
    runtime,
    // Why: mobile pairing needs the stable pre-setName() path (getCanonicalUserDataPath), not a late app.getPath('userData') that drops paired devices across restarts.
    userDataPath: getCanonicalUserDataPath(),
    enableWebSocket: true,
    // Why: STA-2370 — the desktop app binds the WS listener to loopback until the user pairs a device;
    // `orca serve` is an explicit remote opt-in, and E2E keeps the wide bind its harness connects over.
    exposeNetworkByDefault: Boolean(serveOptions) || isE2E,
    ...(isE2E ? { wsPort: e2eWsPort } : {}),
    ...(devWsPort !== undefined ? { wsPort: devWsPort } : {}),
    ...(serveOptions?.wsPort !== undefined
      ? {
          wsPort: serveOptions.wsPort,
          // Why: only explicit `orca serve --port` overrides a stale STA-1511 fallback (issue #8535); default/dev stay fallback-first for pairing stability.
          preferPinnedWsPort: true
        }
      : {}),
    webClientRoot: getBundledWebClientRoot()
  })
  registerMobileHandlers(runtimeRpc, {
    getRelayStatus: () => desktopRelayStatus,
    consumePendingUnpairedDeviceAuthFailure: (webContentsId) => {
      if (
        !mainWindow ||
        mainWindow.isDestroyed() ||
        mainWindow.webContents.id !== webContentsId ||
        !pendingUnpairedDeviceAuthFailure
      ) {
        return false
      }
      pendingUnpairedDeviceAuthFailure = false
      return true
    }
  })
  // Why: repeated direct auth failures otherwise look like a client that never connects; point users to re-pairing.
  runtimeRpc.setOnUnpairedDeviceAuthFailure(() => {
    // Why: runtime startup races renderer mount; retain the one-shot until the listener consumes it.
    pendingUnpairedDeviceAuthFailure = true
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('mobile:unpairedDeviceAuthFailure')
    }
  })

  const shellPathReady = windowsShellPathHydration.whenReady()
  let desktopWindow: BrowserWindow | null = null
  if (process.platform === 'win32' && app.isPackaged && !serveOptions) {
    const desktopStartup = startWindowsDesktopBeforeShellPathReady({
      bindServices: bindTerminalRuntimeStartupServices,
      openWindow: () => openMainWindow({ revealOnDidFinishLoad: true }),
      shellPathReady,
      startServices: startTerminalRuntimeStartupServices
    })
    desktopWindow = desktopStartup.window
  } else {
    await shellPathReady
    bindTerminalRuntimeStartupServices(Promise.resolve(startTerminalRuntimeStartupServices()))
  }
  app.on('activate', handleMacAppActivation)

  if (serveOptions) {
    // Why: give managed WSL launchers a brief chance to migrate before headless PTYs go live, without slow repairs withholding all RPC readiness.
    logStartupMilestone('wsl-cli-barrier-start')
    await managedWslCliStartupBarrierReady
    logStartupMilestone('wsl-cli-barrier-resolved', {
      reconciliation: managedWslCliReconciliationStatus
    })
    // Why: headless PTYs must not start on the fallback provider, then get swept when an activated renderer registers desktop lifecycle handlers.
    await localPtyStartupReady
    await localPtyProviderStartupReady
    await registerHeadlessPtyRuntime(
      runtime,
      prepareCodexRuntimeHomeForLaunch,
      () => store!.getSettings(),
      (target) => claudeRuntimeAuth!.prepareForClaudeLaunch(target),
      store,
      prepareCodexSessionResumeForLaunch,
      {
        onCodexHomePtySpawned: handleCodexHomePtySpawned,
        onPtyExit: handlePtyExit
      }
    )
    await runtime.refreshRestoredOrchestrationAuthority()
    await runtime.reconcileLegacyWorkerTerminals()
    // Why: headless servers can't mount <webview> panes; use offscreen WebContents, gated on a real display so browser.headless.v1 stays honest.
    if (headlessBrowserDisplayAvailable) {
      runtime.setOffscreenBrowserBackend(
        new OffscreenBrowserBackend(browserManager, {
          getAgentBrowserBridge: () => agentBrowserBridge
        })
      )
    }
    // Why: headless servers have no renderer graph publisher; publish an explicit empty graph so status clients see a ready server.
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    await runtimeRpc.start().catch((error) => {
      console.error('[runtime] Failed to start headless RPC transport:', error)
      throw error
    })
    settleServeDesktopActivation()
    // Why: every attempt must reach app.quit(); a page beforeunload can veto an earlier signal.
    registerServeSignalHandlers(process, () => app.quit())
    // Why: headless serve has no renderer to run the normal cli:install flow; do it here for macOS/Linux only (Windows-excluded: install() only mutates registry PATH, not child terminals).
    if (process.platform === 'darwin' || process.platform === 'linux') {
      try {
        // Why: serve is headless — a fallback osascript admin prompt would hang it; skip elevation since ~/.local/bin needs none.
        const cliStatus = await new CliInstaller({
          privilegedRunner: async () => {
            throw new Error('serve CLI auto-install must not request administrator privileges')
          }
        }).install()
        console.log(
          `[serve] orca CLI install: ${cliStatus.state}${cliStatus.commandPath ? ` (${cliStatus.commandPath})` : ''}`
        )
      } catch (error) {
        console.warn(
          '[serve] orca CLI install skipped:',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    // Why: Linux CLI installs as `orca-ide`, but the Claude Team launcher invokes bare `orca`; drop a ~/.local/bin dispatcher (ahead of /usr/bin) so it resolves. Best-effort.
    if (process.platform === 'linux' && app.isPackaged && process.resourcesPath) {
      try {
        const dispatcher = await installLinuxBareOrcaDispatcher({
          resourcesPath: process.resourcesPath
        })
        console.log(
          `[serve] bare orca dispatcher ${dispatcher.state}: ${dispatcher.dispatcherPath}` +
            `${dispatcher.target ? ` -> ${dispatcher.target}` : ''}`
        )
      } catch (error) {
        console.warn(
          '[serve] bare orca dispatcher install skipped:',
          error instanceof Error ? error.message : String(error)
        )
      }
    }
    // Why: headless serve never opens a renderer, so arm scheduled automation dispatch here.
    automations.start()
    // Why: serve deletes worktrees too, and the history GC that normally drains delete tombstones is
    // armed from the main window — without this, a quit mid-removal leaks the tree until a desktop launch.
    scheduleAllPendingHistoryTreeRemovals()
    await printServeReady(serveOptions)
    return
  }

  // Why: window and RPC startup run in parallel; registerPtyHandlers gates PTY spawns so RPC binds without racing the daemon provider swap.
  const desktopRuntimeRpc = runtimeRpc
  if (!desktopRuntimeRpc) {
    throw new Error('runtime_rpc_unavailable')
  }
  const [win, runtimeRpcStartResult] = await Promise.all([
    Promise.resolve(desktopWindow ?? openMainWindow()),
    shellPathReady
      .then(() => desktopRuntimeRpc.start())
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => {
          recordRuntimeRpcStartFailure(error)
          return { ok: false as const, error }
        }
      )
  ])
  if (!runtimeRpcStartResult.ok) {
    void showRuntimeRpcStartupFailureDialog(win, runtimeRpcStartResult.error)
  }

  const cloudAuth = getOrcaCloudAuthConfig()
  if (cloudAuth.configured) {
    try {
      const relayService = new DesktopRelayService({
        authConfig: cloudAuth.config,
        userDataPath: getProfileUserDataPath(),
        appVersion: app.getVersion(),
        runtimeRpc,
        onStatus: (status) => {
          desktopRelayStatus = status
          mainWindow?.webContents.send('mobile:relayStatusChanged', status)
        }
      })
      desktopRelayService = relayService
      runtimeRpc.setMobileRelayPairingProvider({
        createPairingRelay: (relayDeviceId) => relayService.createPairingRelay(relayDeviceId),
        onDeviceRevokeQueued: (item) => relayService.onDeviceRevokeQueued(item),
        onDemandStateChanged: () => relayService.demandStateChanged(),
        getEndpoints: (context, params) => relayService.getEndpoints(context, params),
        provisionRelay: (context, params) => relayService.provisionRelay(context, params)
      })
      relayService.start()
      // Why: sleeping past relay-token expiry kills the broker with no retry
      // timer; resume is the moment that state becomes recoverable.
      powerMonitor.on('resume', () => desktopRelayService?.ensureLive())
    } catch (error) {
      console.warn(
        '[relay] Desktop relay startup unavailable:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  // Why: macOS notification permission dialog must fire after the window is shown, else it's hidden behind the maximized window.
  win.once('show', () => {
    // Why: store can be null if init failed earlier; bail rather than throw inside an Electron event listener.
    if (!store) {
      return
    }
    const onboarding = store.getOnboarding()
    if (onboarding.closedAt !== null) {
      triggerStartupNotificationRegistration(store)
    }
  })
})

// Why: app.exit() skips Electron quit events, so keep its log child from surviving forced exits.
process.once('exit', stopTccPromptNotice)

app.on('before-quit', () => {
  if (isQuittingForUpdate()) {
    recordUpdaterLifecycle('before_quit_allowed', undefined, {
      message: 'before-quit allowed for update install'
    })
  }
  isQuitting = true
  desktopRelayService?.fenceAndCloseNow()
  runtimeRpc?.setMobileRelayPairingProvider(null)
  unsubscribeAgentAwakeStatusChanges?.()
  unsubscribeAgentAwakeStatusChanges = null
  agentAwakeService?.dispose()
  agentAwakeService = null
  // Why: defer PTY cleanup to will-quit so the renderer captures scrollback before PTY-exit events unmount TerminalPane (dropping its capture callbacks).
  rateLimits?.stop()
})

// Why: will-quit fires twice — first pass preventDefaults and runs teardown; second pass exits.
let daemonDisconnectDone = false
// Why 2s: a config delete is best-effort, not durable state.
const GROK_HOOK_CLEANUP_DEADLINE_MS = 2_000

app.on('will-quit', (e) => {
  // Why return instead of re-running teardown: the second pass is Electron re-firing after
  // our own app.quit(), so every step below already ran and every durable write already
  // landed. Re-entering would start a fresh unawaited write that the exit then tears down.
  if (daemonDisconnectDone) {
    return
  }
  // Why preventDefault before any work: everything below must be free to await, and a
  // synchronous durable write here parks the main thread — uninterruptibly, on a stalled
  // network profile mount. The teardown deadline cannot rescue that, because its timer
  // lives on the same thread it would need to bound (#9447 covers the wedged-transport
  // half; this covers the blocked-syscall half).
  if (!quitTeardownStartGate.tryStart(e)) {
    return
  }
  unsubscribeSystemResumeBroadcast?.()
  unsubscribeSystemResumeBroadcast = null
  // Why: renderer guards can still cancel before this committed phase; `log stream` must survive those vetoes.
  stopTccPromptNotice()
  const updateQuitInProgress = isQuittingForUpdate()
  if (updateQuitInProgress) {
    recordUpdaterLifecycle(
      'will_quit_cleanup_started',
      { daemonTeardown: 'disconnect' },
      { message: 'will-quit cleanup for update install; daemonTeardown=disconnect' }
    )
  }
  // Why: before-quit can still be aborted by renderer beforeunload; only remove the Windows tray icon on the committed quit path.
  destroySystemTray()
  // Why: an agent still working at quit gets no terminating hook, so stats.flushAsync() closes those sessions out synchronously (only the write is deferred) — otherwise their duration is lost.
  starNag?.stop()
  automations?.stop()
  // Why: plugin hosts are forked children; dispose sends shutdown and
  // escalates to SIGKILL so they cannot outlive the app. The promise joins
  // the teardown barrier below — quitting before it resolves would let
  // Electron exit first and orphan the hosts.
  setPluginServiceForRpc(null)
  pluginKillListService = null
  pluginMarketplaceService = null
  pluginMarketplaceInstaller = null
  const pluginHostShutdown = pluginService?.dispose() ?? Promise.resolve()
  const codexBackfillRecoveryShutdown = stopCodexStateDbBackfillRecoveries()
  const structuredAgentSessionShutdown = stopStructuredAgentSessionRuntime()
  pluginService = null
  setUnreadDockBadgeCount(0)
  agentHookServer.stop()
  // Why Windows only: POSIX hooks short-circuit on ORCA_PANE_KEY, while Windows must register a
  // bare script path that cannot express the guard and would otherwise keep spawning after quit.
  // Why bounded here: every other teardown member carries its own ceiling, and this one reaches
  // $GROK_HOME -- which can be a stalled network mount, where the fs calls never settle and the
  // shared 20s deadline becomes the only thing ending the quit.
  const grokHookCleanup =
    process.platform === 'win32'
      ? settleWithinMs(
          removeManagedAgentHooksAsync({ agents: ['grok'] }),
          GROK_HOOK_CLEANUP_DEADLINE_MS
        ).then((settled) => {
          if (settled.outcome === 'timed-out') {
            console.warn('[agent-hooks] Grok hook cleanup on quit timed out')
            return
          }
          if (settled.outcome === 'failed') {
            console.warn('[agent-hooks] Grok hook cleanup on quit failed:', settled.error)
            return
          }
          // Why: removers report failures as statuses, so inspect details even after fulfillment.
          for (const status of settled.value.filter((entry) => entry.detail)) {
            console.warn(`[agent-hooks] ${status.agent} hook cleanup on quit: ${status.detail}`)
          }
        })
      : Promise.resolve()
  // Why: cancels relay restart/reinstall timers and kills wsl.exe children deterministically, not via stdio-pipe teardown.
  wslHookRelayManager.disposeAll()
  const statsFlush = stats?.flushAsync() ?? Promise.resolve()
  // Why: agent-browser daemon processes would otherwise linger after quit, holding ports and stale session state on disk.
  // Why the barrier below: each session's close is its own agent-browser child taking hundreds of ms,
  // so an unawaited call reaches app.quit() first and every open tab's daemon survives the quit (#16367).
  // Why retire headless page owners first: it closes those helpers without a duplicate close fanout.
  const browserShutdown = (async (): Promise<void> => {
    await runtime?.getOffscreenBrowserBackend()?.destroyAll?.()
    await runtime?.getAgentBrowserBridge()?.destroyAllSessions()
  })()
  // Why (review P2-4): local SSH browser routes own loopback listeners and, on the
  // system-ssh path, `ssh -N -D` children that would otherwise outlive the app.
  const localSshRouteShutdown = import('./browser/local-ssh-browser-route')
    .then((routes) => routes.closeAllLocalSshBrowserRoutes())
    .catch(() => {})
  browserManager.setBrowserGuestStateChangedListener(null)
  const emulatorShutdown = runtime?.getEmulatorBridge()?.destroyAllSessions() ?? Promise.resolve()
  // Why immediately before store.flushAsync() with no await in between: beginSshShutdown() marks every
  // active SSH lease detached in memory synchronously, and that flush is what persists it.
  const sshShutdown = beginSshShutdown()
  killAllPty()
  const watcherShutdown = shutdownWatchersOnce()
  const storeFlush = store?.flushAsync() ?? Promise.resolve()
  // Why: usage-cache writes are queued off the main thread, so a quit right after setEnabled or a
  // scan completion would drop the final snapshot. Captured before any await; joins the barrier below.
  const usageCacheFlush = Promise.all([
    claudeUsage?.flush(),
    codexUsage?.flush(),
    openCodeUsage?.flush()
  ]).then(() => {})
  const browserClientHostShutdown = shutdownPairedRuntimeBrowserClientHosts()
  const skillUploadShutdown = runtime?.disposeSkillUploadSessions() ?? Promise.resolve()

  // Why: capture pid/runtimeId synchronously (before any await) so a later teardown path can't null them out mid-chain.
  const ownedPid = process.pid
  const ownedRuntimeId = runtime?.getRuntimeId()
  const rpcStopAndClear = runtimeRpc
    ? runtimeRpc
        .stop()
        .then(() => awaitRuntimeFileWatcherUnsubscribes())
        .then(() => {
          if (ownedRuntimeId) {
            // Why: must match the path the runtime server wrote metadata to (getCanonicalUserDataPath), not late app.getPath('userData').
            clearRuntimeMetadataIfOwned(getCanonicalUserDataPath(), ownedPid, ownedRuntimeId)
          }
        })
        .catch((error) => {
          console.error('[runtime] Failed to stop local RPC transport:', error)
        })
    : Promise.resolve()
  // Why: allSettled (not all) keeps fail-open — a daemon-disconnect rejection still quits instead of hanging.
  // Why: telemetry flush folds in before app.quit() (bounded 2s); catch defensively so a flush failure can't cancel the quit chain.
  // Why: normal quits keep the detached daemon for warm reattach, but a dead dev parent leaves the temp/dev profile ownerless.
  const daemonTeardown = isDevParentShutdownRequested() ? shutdownDaemon() : disconnectDaemon()
  // Why: a wedged transport (half-open post-sleep socket) can leave one
  // member unsettled forever and block app.quit() until Force Quit (#9447).
  // Why stats/state join here: their writes are durable but not worth hanging the app for.
  // Losing at most the last debounce interval beats a quit that never completes, and the
  // temp+rename swap means a write cut short by the deadline leaves the old file intact.
  settleTeardownWithinDeadline([
    { name: 'daemon', promise: daemonTeardown },
    { name: 'browser', promise: browserShutdown },
    { name: 'runtime-rpc', promise: rpcStopAndClear },
    { name: 'watchers', promise: watcherShutdown },
    { name: 'emulator', promise: emulatorShutdown },
    { name: 'browser-client-hosts', promise: browserClientHostShutdown },
    { name: 'local-ssh-browser-routes', promise: localSshRouteShutdown },
    { name: 'ssh', promise: sshShutdown },
    { name: 'plugin-hosts', promise: pluginHostShutdown },
    { name: 'skill-uploads', promise: skillUploadShutdown },
    { name: 'grok-hooks', promise: grokHookCleanup },
    { name: 'codex-backfill-recovery', promise: codexBackfillRecoveryShutdown },
    { name: 'structured-agent-session', promise: structuredAgentSessionShutdown },
    { name: 'usage-cache', promise: usageCacheFlush },
    { name: 'stats', promise: statsFlush },
    { name: 'state', promise: storeFlush }
  ])
    .then((pendingTeardowns) => {
      if (pendingTeardowns.length > 0) {
        console.warn('[shutdown] Quit teardown deadline reached', { pendingTeardowns })
      }
    })
    .then(() => shutdownTelemetry())
    .then(() => shutdownObservability())
    .catch(() => {
      /* swallow — telemetry must never prevent app.quit() */
    })
    .then(() => {
      daemonDisconnectDone = true
      app.quit()
    })
})

app.on('window-all-closed', () => {
  // Why: serve mode / disposable offscreen browser windows must not take down runtime RPC — the policy fn keeps the app alive.
  // Why: on macOS a quit-in-progress (Cmd+Q) is canceled by the renderer buffer-capture deferral; re-trigger quit so it actually exits.
  if (
    shouldQuitWhenAllWindowsClosed({
      platform: process.platform,
      isQuitting,
      isServeMode
    })
  ) {
    app.quit()
  }
})
