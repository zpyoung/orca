import type { BrowserWindow } from 'electron'
import type {
  LinuxPackageInstallInstructions,
  UpdateCheckOptions,
  UpdateStatus
} from '../shared/update-status-types'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot,
  RemoteServerUpdateSupport
} from '../shared/remote-server-update'
import type { ReleaseBuild, ReleaseChannel } from '../shared/release-channel'
import { UpdaterSetup, type UpdaterSetupOptions } from './updater/updater-setup'
import type { UpdateInstallMode } from './updater/updater-state'

// Keep one service instance so all public API calls share updater state and event listeners.
const updater = new UpdaterSetup()

export type { UpdateInstallMode, UpdaterSetupOptions }

export function resolveUpdateInstallMode(isServeMode: boolean): UpdateInstallMode {
  return updater.resolveUpdateInstallMode(isServeMode)
}

export function getUpdateStatus(): UpdateStatus {
  return updater.getUpdateStatus()
}

export function getRemoteServerUpdateSupport(): RemoteServerUpdateSupport {
  return updater.getRemoteServerUpdateSupport()
}

export function getRemoteServerUpdaterSnapshot(runtimeId: string): RemoteServerUpdaterSnapshot {
  return updater.getRemoteServerUpdaterSnapshot(runtimeId)
}

export function checkForRemoteServerUpdate(
  runtimeId: string,
  options?: UpdateCheckOptions
): RemoteServerUpdaterSnapshot {
  return updater.checkForRemoteServerUpdate(runtimeId, options)
}

export function downloadRemoteServerUpdate(runtimeId: string): RemoteServerUpdaterSnapshot {
  return updater.downloadRemoteServerUpdate(runtimeId)
}

export function installRemoteServerUpdate(runtimeId: string): RemoteServerUpdateInstallResult {
  assertRemoteServerUpdateAvailable()
  if (currentStatus.state !== 'downloaded') {
    throw new Error('remote_update_not_downloaded')
  }
  const targetVersion = currentStatus.version
  const result: RemoteServerUpdateInstallResult = {
    accepted: true,
    fromVersion: app.getVersion(),
    targetVersion,
    runtimeId
  }
  quitAndInstall()
  return result
}

let consecutiveAutomaticRetrySchedules = 0

function scheduleAutomaticUpdateCheck(delayMs: number): void {
  let effectiveDelayMs = delayMs
  // All retry-cadence callers pass exactly this constant, so keying backoff on it keeps one choke point instead of threading a flag through every schedule site.
  if (delayMs === AUTO_UPDATE_RETRY_INTERVAL_MS) {
    effectiveDelayMs = Math.min(
      AUTO_UPDATE_RETRY_INTERVAL_MS * 2 ** consecutiveAutomaticRetrySchedules,
      MAX_AUTO_UPDATE_RETRY_INTERVAL_MS
    )
    consecutiveAutomaticRetrySchedules += 1
  }
  if (autoUpdateCheckTimer) {
    clearTimeout(autoUpdateCheckTimer)
  }
  autoUpdateCheckTimer = setTimeout(() => {
    // Why: Orca runs for days, so keep the next background check scheduled in the main process rather than tying it to relaunches or renderer lifetime.
    if (!runBackgroundUpdateCheck()) {
      // Why: a deferred check reaches no outcome handler, so re-arm here or one deferral ends automatic checks for the process lifetime.
      scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
    }
  }, effectiveDelayMs)
}

function recordCompletedUpdateCheck(): void {
  consecutiveAutomaticRetrySchedules = 0
  persistLastUpdateCheckAt?.(Date.now())
}

function getMissingManifestPrereleaseFallbackUserInitiated(): boolean | null {
  if (
    !pendingPrereleaseFallback?.retryLaunched ||
    pendingPrereleaseFallback.fallbackResultHandled
  ) {
    return null
  }
  return pendingPrereleaseFallback.userInitiated
}

function markMissingManifestPrereleaseFallbackChecking(): void {
  if (
    !pendingPrereleaseFallback?.retryLaunched ||
    pendingPrereleaseFallback.fallbackResultHandled
  ) {
    return
  }
  pendingPrereleaseFallback.fallbackCheckingForUpdateSeen = true
}

function consumeMissingManifestPrereleaseFallbackResult(): MissingManifestPrereleaseFallbackResult | null {
  if (
    !pendingPrereleaseFallback?.retryLaunched ||
    pendingPrereleaseFallback.fallbackResultHandled
  ) {
    return null
  }
  const result = { userInitiated: pendingPrereleaseFallback.userInitiated }
  pendingPrereleaseFallback.fallbackResultHandled = true
  clearPrereleaseFallbackContextIfSettled()
  return result
}

function suppressMissingManifestPrereleaseFallbackPromiseFailure(message: string): void {
  if (
    !pendingPrereleaseFallback?.retryLaunched ||
    pendingPrereleaseFallback.fallbackResultHandled
  ) {
    return
  }
  pendingPrereleaseFallback.suppressedFallbackPromiseFailureKey = getCheckFailureKey(
    message,
    pendingPrereleaseFallback.userInitiated
  )
}

function shouldSuppressMissingManifestPrereleaseFallbackEvent(
  message: string,
  error: unknown
): boolean {
  if (!pendingPrereleaseFallback?.retryLaunched) {
    return false
  }
  const failureKey = getCheckFailureKey(message, pendingPrereleaseFallback.userInitiated)
  const primaryEventSuppression = pendingPrereleaseFallback.suppressedPrimaryEventFailure
  if (primaryEventSuppression?.failureKey === failureKey) {
    const isPrimaryPromisePair = primaryEventSuppression.error === error
    // Why: after fallback checking starts, same-message errors may be the fallback's, so message matching alone isn't safe.
    if (isPrimaryPromisePair || !pendingPrereleaseFallback.fallbackCheckingForUpdateSeen) {
      pendingPrereleaseFallback.suppressedPrimaryEventFailure = null
      clearPrereleaseFallbackContextIfSettled()
      return true
    }
  }
  if (pendingPrereleaseFallback.suppressedFallbackEventFailureKey === failureKey) {
    pendingPrereleaseFallback.suppressedFallbackEventFailureKey = null
    clearPrereleaseFallbackContextIfSettled()
    return true
  }
  return false
}

function markMissingManifestPrereleaseFallbackPromiseHandled(message: string): void {
  if (
    !pendingPrereleaseFallback?.retryLaunched ||
    pendingPrereleaseFallback.fallbackResultHandled
  ) {
    return
  }
  pendingPrereleaseFallback.suppressedFallbackEventFailureKey = getCheckFailureKey(
    message,
    pendingPrereleaseFallback.userInitiated
  )
}

async function pinDefaultReleaseFeed(
  variant: UpdateCheckVariant = 'default'
): Promise<ReleaseFeedPreflightResult> {
  const autoUpdater = getAutoUpdater()
  // Why: the latest/download redirect can move between check and download, so pin the concrete tag (prerelease users resolve any channel, stable only stable).
  const currentVersion = app.getVersion()
  const isPerfCheck = variant === 'perf'
  const includePrerelease =
    isPerfCheck || includePrereleaseActive || isPrereleaseVersion(currentVersion)
  const releaseTagsResult = await fetchNewerReleaseTagsWithReadiness(
    currentVersion,
    includePrerelease ? 2 : 1,
    {
      includePrerelease,
      ...(isPerfCheck ? { releaseFilter: 'perf' as const } : {})
    }
  )
  const newerTag = releaseTagsResult.tags[0] ?? null
  const fallbackTag = includePrerelease ? (releaseTagsResult.tags[1] ?? null) : null
  pendingPrereleaseFallback =
    includePrerelease && newerTag && fallbackTag
      ? {
          primaryTag: newerTag,
          fallbackTag,
          userInitiated: false,
          suppressedPrimaryPromiseFailureKey: null,
          suppressedPrimaryEventFailure: null,
          suppressedFallbackPromiseFailureKey: null,
          suppressedFallbackEventFailureKey: null,
          fallbackResultHandled: false,
          fallbackCheckingForUpdateSeen: false,
          retryLaunched: false
        }
      : null
  // Why: console.info is captured by Console.app/--enable-logging — our only field visibility into the updater.
  if (newerTag) {
    clearPublishingWindowLastGoodCheck()
    const url = getReleaseDownloadUrl(newerTag)
    console.info(
      `[updater] release feed pinned: current=${currentVersion} includePrerelease=${includePrerelease} → ${url}`
    )
    autoUpdater.setFeedURL({ provider: 'generic', url })
    return 'ready'
  } else if (releaseTagsResult.state === 'not-ready') {
    clearPrereleaseFallbackContext()
    if (releaseTagsResult.lastGoodTag) {
      // Why: during a publish window the newest tag is unsafe; a verified last-good concrete feed lets electron-updater emit a real result.
      const url = getReleaseDownloadUrl(releaseTagsResult.lastGoodTag)
      console.info(
        `[updater] release feed pinned to last-good: current=${currentVersion} includePrerelease=${includePrerelease} → ${url}`
      )
      publishingWindowLastGoodCheck = { lastGoodTag: releaseTagsResult.lastGoodTag }
      autoUpdater.setFeedURL({ provider: 'generic', url })
      return 'ready'
    }
    clearPublishingWindowLastGoodCheck()
    console.info(
      `[updater] release feed deferred: current=${currentVersion} includePrerelease=${includePrerelease}; newest release assets are not ready`
    )
    throw new ReleaseFeedPreflightError(
      'release-not-ready',
      isPerfCheck ? 'perf' : includePrerelease ? 'prerelease' : 'default',
      'Latest release artifacts are not ready'
    )
  } else if (
    releaseTagsResult.state === 'unavailable' &&
    releaseTagsResult.unavailableReason === 'manifest' &&
    !includePrerelease
  ) {
    clearPrereleaseFallbackContext()
    clearPublishingWindowLastGoodCheck()
    throw new ReleaseFeedPreflightError(
      'manifest-unavailable',
      'default',
      'Unable to find latest version on GitHub'
    )
  } else if (isPerfCheck) {
    clearPrereleaseFallbackContext()
    clearPublishingWindowLastGoodCheck()
    if (releaseTagsResult.state === 'no-newer') {
      console.info(
        `[updater] perf release not found: current=${currentVersion} includePrerelease=${includePrerelease}`
      )
      return 'not-available'
    }
    throw new Error('Could not resolve perf update feed')
  } else {
    clearPrereleaseFallbackContext()
    clearPublishingWindowLastGoodCheck()
    const url = 'https://github.com/zpyoung/orca/releases/latest/download'
    console.info(
      `[updater] release feed fallback: current=${currentVersion} includePrerelease=${includePrerelease} → ${url}`
    )
    autoUpdater.setFeedURL({ provider: 'generic', url })
    return 'ready'
  }
}

function retryPrereleaseFallbackAfterMissingManifest(
  message: string,
  userInitiated: boolean | undefined,
  source: CheckFailureSource,
  failureKey: string,
  sourceError?: unknown
): boolean {
  if (
    !pendingPrereleaseFallback ||
    pendingPrereleaseFallback.retryLaunched ||
    !isMissingUpdateManifestFailure(message)
  ) {
    return false
  }
  const attemptId = activeUpdateCheckAttemptId
  if (attemptId === null) {
    return false
  }

  // Why: a published tag can briefly lack its platform manifest mid-release; walk back once to the previous feed for a normal not-available result.
  pendingPrereleaseFallback.retryLaunched = true
  pendingPrereleaseFallback.userInitiated = Boolean(userInitiated)
  pendingPrereleaseFallback.suppressedPrimaryPromiseFailureKey =
    source === 'event' ? failureKey : null
  pendingPrereleaseFallback.suppressedPrimaryEventFailure =
    source === 'promise' ? { failureKey, error: sourceError } : null
  pendingPrereleaseFallback.fallbackCheckingForUpdateSeen = false
  const { primaryTag, fallbackTag } = pendingPrereleaseFallback
  const url = getReleaseDownloadUrl(fallbackTag)
  console.info(
    `[updater] prerelease manifest missing for ${primaryTag}; retrying once against ${url}`
  )
  const autoUpdater = getAutoUpdater()
  autoUpdater.setFeedURL({ provider: 'generic', url })
  userInitiatedCheck = Boolean(userInitiated)
  backgroundCheckLaunchPending = !userInitiated
  armUpdateCheckStallTimer(attemptId)
  markUpdateCheckLaunched(attemptId)
  void autoUpdater
    .checkForUpdates()
    .then(() => handleSettledUpdateCheckPromise(attemptId))
    .catch((err) => {
      if (!isActiveUpdateCheckAttempt(attemptId)) {
        return
      }
      const message = String(err?.message ?? err)
      if (userInitiated) {
        userInitiatedCheck = false
      } else {
        backgroundCheckLaunchPending = false
      }
      markMissingManifestPrereleaseFallbackPromiseHandled(message)
      consumeMissingManifestPrereleaseFallbackResult()
      void sendCheckFailureStatus(message, userInitiated, 'fallback-promise', err)
    })
  return true
}

/** Returns false when the check was deferred instead of launched, so timer-driven callers can re-arm. */
function runBackgroundUpdateCheck(
  nudgeId: string | null = getPersistedPendingUpdateNudgeId()
): boolean {
  // Why: a pinned dev jump owns the feed until it settles; a background check
  // would repoint it mid-flight and download the wrong build.
  if (
    activeUpdateSource !== 'release' ||
    isPinnedBuildActive ||
    localBuildSelectionInProgress ||
    pinnedBuildSelectionInProgress
  ) {
    return false
  }
  if (backgroundCheckLaunchPending || currentStatus.state === 'checking') {
    return false
  }
  if (!app.isPackaged || is.dev) {
    sendStatus({ state: 'not-available' })
    return false
  }
  // Why: set the nudge marker before any events arrive so later checks can't inherit a stale campaign id; persisted id keeps a nudge card dismissable after relaunch.
  activeUpdateNudgeId = nudgeId
  // Why: 'checking-for-update' arrives a tick later, so a second focus/resume can slip in before status flips; track launch in memory to dedupe that gap.
  backgroundCheckLaunchPending = true
  backgroundCheckPromotedToUserInitiated = false
  const attemptId = beginUpdateCheckAttempt()
  // Don't send 'checking' here — the 'checking-for-update' handler does; sending from both dupes notifications (issue #35).
  const autoUpdater = getAutoUpdater()
  const launch = (): Promise<unknown> | undefined => {
    if (!isActiveUpdateCheckAttempt(attemptId)) {
      return undefined
    }
    markUpdateCheckLaunched(attemptId)
    return autoUpdater.checkForUpdates()
  }
  const run = pinDefaultReleaseFeed().then(launch)
  void Promise.resolve(run)
    .then(() => handleSettledUpdateCheckPromise(attemptId))
    .catch((err) => {
      if (!isActiveUpdateCheckAttempt(attemptId)) {
        return
      }
      const wasUserInitiated = getSettledCheckUserInitiated()
      backgroundCheckLaunchPending = false
      backgroundCheckPromotedToUserInitiated = false
      if (wasUserInitiated) {
        userInitiatedCheck = false
      }
      void sendCheckFailureStatus(String(err?.message ?? err), wasUserInitiated, 'promise', err)
    })
  return true
}

export function checkForUpdates(): void {
  updater.checkForUpdates()
}

export function checkForUpdatesFromMenu(options?: UpdateCheckOptions): void {
  if (!app.isPackaged || is.dev) {
    sendStatus({ state: 'not-available', userInitiated: true })
    return
  }
  if (options?.localBuild) {
    void checkForLocalBuildFromMenu()
    return
  }
  if (options?.targetTag && options.channel) {
    void checkForPinnedBuild(options.channel, options.targetTag)
    return
  }
  if (localBuildSelectionInProgress || pinnedBuildSelectionInProgress) {
    return
  }
  if (
    activeUpdateSource !== 'release' &&
    (currentStatus.state === 'checking' || currentStatus.state === 'downloading')
  ) {
    return
  }
  restoreReleaseUpdateSource()

  const checkVariant = getUpdateCheckVariant(options)
  if (checkVariant === 'prerelease') {
    clearPrereleaseFallbackContext()
    enableIncludePrerelease()
  } else if (checkVariant === 'perf') {
    clearPrereleaseFallbackContext()
    // Why: perf checks need prerelease manifests now, but must not opt future default/background checks into the RC channel.
    enablePrereleaseManifestChecks()
  }

  const checkAlreadyInFlight = backgroundCheckLaunchPending || currentStatus.state === 'checking'
  userInitiatedCheck = true
  // Why: manual checks are nudge-independent; clear the marker so a later dismiss can't consume the campaign by accident.
  activeUpdateNudgeId = null
  // Why: respond visibly before feed pinning/updater events; duplicate broadcasts are suppressed by status equality below.
  sendStatus({ state: 'checking', userInitiated: true })
  if (checkAlreadyInFlight) {
    backgroundCheckPromotedToUserInitiated = true
    rearmActiveUpdateCheckStallTimer()
    if (checkVariant !== 'default') {
      // Why: in-flight check may have pinned the stable feed; queue a fresh modifier check to avoid a stale-channel result.
      pendingUserInitiatedCheckAfterInFlight = checkVariant
    }
    return
  }

  const attemptId = beginUpdateCheckAttempt()
  const autoUpdater = getAutoUpdater()
  const launch = (): Promise<unknown> | undefined => {
    if (!isActiveUpdateCheckAttempt(attemptId)) {
      return undefined
    }
    markUpdateCheckLaunched(attemptId)
    return autoUpdater.checkForUpdates()
  }
  const run = pinDefaultReleaseFeed(checkVariant).then((preflightResult) => {
    if (preflightResult === 'not-available') {
      if (!isActiveUpdateCheckAttempt(attemptId)) {
        return false
      }
      userInitiatedCheck = false
      finishActiveUpdateCheckAttempt()
      recordCompletedUpdateCheck()
      sendStatus({ state: 'not-available', userInitiated: true })
      return false
    }
    return launch()
  })
  void Promise.resolve(run)
    .then((launchResult) => {
      if (launchResult === false) {
        return
      }
      handleSettledUpdateCheckPromise(attemptId)
    })
    .catch((err) => {
      if (!isActiveUpdateCheckAttempt(attemptId)) {
        return
      }
      userInitiatedCheck = false
      void sendCheckFailureStatus(String(err?.message ?? err), true, 'promise', err)
    })
}

async function checkForLocalBuildFromMenu(): Promise<void> {
  if (process.platform !== 'darwin') {
    sendLocalBuildErrorAndRestore(
      'Local build switching is currently available only on macOS.',
      true
    )
    return
  }
  if (currentStatus.state === 'checking' || currentStatus.state === 'downloading') {
    return
  }
  if (localBuildSelectionInProgress) {
    return
  }
  localBuildSelectionInProgress = true
  try {
    const [{ chooseLocalBuild }, { startLocalBuildFeed }] = await Promise.all([
      import('./local-builds/local-build-switch'),
      import('./local-builds/local-build-feed-server')
    ])
    const candidate = await chooseLocalBuild(mainWindowRef)
    if (!candidate) {
      return
    }
    closeLocalBuildFeed()
    const feed = await startLocalBuildFeed(candidate)
    activeLocalBuildFeed = feed
    activeUpdateSource = 'local'
    clearPrereleaseFallbackContext()
    clearPublishingWindowLastGoodCheck()
    clearAvailableUpdateContext()
    activeUpdateNudgeId = null
    userInitiatedCheck = true
    sendStatus({ state: 'checking', userInitiated: true })

    const updater = getAutoUpdater()
    updater.allowDowngrade = true
    updater.disableDifferentialDownload = true
    updater.setFeedURL({ provider: 'generic', url: feed.url })
    const attemptId = beginUpdateCheckAttempt()
    markUpdateCheckLaunched(attemptId)
    await updater.checkForUpdates()
    handleSettledUpdateCheckPromise(attemptId)
  } catch (error) {
    userInitiatedCheck = false
    sendLocalBuildErrorAndRestore(String((error as Error)?.message ?? error), true)
  } finally {
    localBuildSelectionInProgress = false
  }
}

export async function listAvailableReleaseBuilds(channel: ReleaseChannel): Promise<ReleaseBuild[]> {
  return listReleaseBuilds(channel)
}

/**
 * Pins the updater at one exact release tag and checks it, so a dev can move to
 * any published build on any channel — including an older one.
 *
 * Unlike a routine check this sets `allowDowngrade`, because "jump to yesterday's
 * hourly" is a downgrade by semver. The pin is torn down as soon as the attempt
 * settles so ordinary background checks never inherit it.
 */
async function checkForPinnedBuild(channel: ReleaseChannel, tag: string): Promise<void> {
  if (!app.isPackaged || is.dev) {
    sendStatus({ state: 'not-available', userInitiated: true })
    return
  }
  // Why here as well as in the picker: the renderer disables the option, but IPC
  // is reachable regardless, and there is no artifact to install on a platform
  // the dev workflows do not build for.
  if (!isChannelSupportedOnPlatform(channel, process.platform)) {
    sendStatus({
      state: 'error',
      message: `${RELEASE_CHANNEL_LABELS[channel]} builds are produced only for ${DEV_CHANNEL_PLATFORM_LABEL}.`,
      userInitiated: true
    })
    return
  }
  // Why: electron-updater would otherwise take this all the way to a download
  // and fail it with a raw ERR_UPDATER_INVALID_SIGNATURE. Say what to do instead
  // — the installer is run by hand once, and in-app updates work from there on.
  if (
    requiresManualDevChannelInstall({
      platform: process.platform,
      runningChannel: getVersionChannel(app.getVersion()),
      targetChannel: channel
    })
  ) {
    sendStatus({
      state: 'error',
      message: `${RELEASE_CHANNEL_LABELS[channel]} builds are unsigned, and this signed build only installs updates signed by Orca's publisher. Download the installer from the release page and run it once — updates work normally from there, including back to Stable.`,
      userInitiated: true
    })
    return
  }
  if (currentStatus.state === 'checking' || currentStatus.state === 'downloading') {
    return
  }
  if (localBuildSelectionInProgress || pinnedBuildSelectionInProgress) {
    return
  }
  pinnedBuildSelectionInProgress = true
  try {
    const target = resolveTargetBuild(channel, tag)
    if (compareVersions(target.version, app.getVersion()) === 0) {
      sendStatus({ state: 'not-available', userInitiated: true })
      return
    }
    closeLocalBuildFeed()
    activeUpdateSource = hasDedicatedReleaseRepo(channel) ? channel : 'release'
    isPinnedBuildActive = true
    clearPrereleaseFallbackContext()
    clearPublishingWindowLastGoodCheck()
    clearAvailableUpdateContext()
    activeUpdateNudgeId = null
    userInitiatedCheck = true
    sendStatus({ state: 'checking', userInitiated: true })

    const updater = getAutoUpdater()
    // Why: an intentional jump to an older tag must not be filtered out as "not newer".
    updater.allowDowngrade = true
    updater.disableDifferentialDownload = true
    updater.allowPrerelease = true
    console.info(`[updater] pinned to ${channel} build ${target.tag} → ${target.feedUrl}`)
    updater.setFeedURL({ provider: 'generic', url: target.feedUrl })
    availableReleaseUrl = target.feedUrl
    const attemptId = beginUpdateCheckAttempt()
    markUpdateCheckLaunched(attemptId)
    await updater.checkForUpdates()
    handleSettledUpdateCheckPromise(attemptId)
  } catch (error) {
    userInitiatedCheck = false
    clearAvailableUpdateContext()
    restoreReleaseUpdateSource()
    sendStatus({
      state: 'error',
      message: String((error as Error)?.message ?? error),
      userInitiated: true
    })
  } finally {
    pinnedBuildSelectionInProgress = false
  }
}

export function isQuittingForUpdate(): boolean {
  return quittingForUpdate
}

function getActiveLinuxPackageRecovery(): LinuxPackageInstallRecovery | null {
  if (currentStatus.state !== 'error') {
    return null
  }
  return currentStatus.recovery?.kind === 'linux-package-install' ? currentStatus.recovery : null
}

const LINUX_PACKAGE_RECOVERY_MESSAGES: Record<LinuxPackageRecoveryUnavailableReason, string> = {
  missing:
    'The downloaded package is no longer in the update cache. Download the update again, or get it from the official release page.',
  // Why: this reason also covers a path that left the cache (traversal or symlinked parent), so the copy must not promise the file merely changed type.
  'not-regular':
    'The downloaded package is no longer a valid file in the update cache. Download the update again, or get it from the official release page.',
  'hash-mismatch':
    'The downloaded package no longer matches the verified release, so Orca will not hand it to a package manager. Download the update again, or get it from the official release page.',
  'read-failed':
    'Orca could not read the downloaded package. Download the update again, or get it from the official release page.',
  'no-sudo':
    'No sudo command was found in the system directories, so Orca cannot build a safe install command. Show the package and install it with your package manager.',
  'no-package-manager':
    'No supported package manager was found in the system directories, so Orca cannot build a safe install command. Show the package and install it with your package manager.',
  // Defensive: capture only ever tracks absolute cache paths, so this reports a bug rather than a machine state.
  'invalid-package-path':
    'The downloaded package is not at a usable path, so Orca cannot build a safe install command. Show the package and install it with your package manager.'
}

// Why: clearing the artifact alone would leave the renderer's actions enabled; the status must lose its recovery too.
const RECOVERY_CLEARING_REASONS: LinuxPackageRecoveryUnavailableReason[] = [
  'missing',
  'not-regular',
  'hash-mismatch'
]

function recordLinuxPackageRecoveryUnavailable(
  recovery: LinuxPackageInstallRecovery,
  reason: LinuxPackageRecoveryUnavailableReason
): void {
  recordUpdaterLifecycle(
    'linux_package_recovery_unavailable',
    { reason, packageType: recovery.packageType, version: recovery.version },
    { level: 'warn', message: 'Linux package recovery action unavailable' }
  )
}

function failLinuxPackageRecovery(
  recovery: LinuxPackageInstallRecovery,
  reason: LinuxPackageRecoveryUnavailableReason
): never {
  recordLinuxPackageRecoveryUnavailable(recovery, reason)
  const message = LINUX_PACKAGE_RECOVERY_MESSAGES[reason]
  // Why: hashing 160 MB takes long enough for a new cycle to land. Acting on a stale verdict would
  // destroy the newer artifact and clobber whatever card replaced this one.
  const active = getActiveLinuxPackageRecovery()
  const stillCurrent =
    active?.version === recovery.version && active?.packageType === recovery.packageType
  if (stillCurrent && RECOVERY_CLEARING_REASONS.includes(reason)) {
    clearTrackedLinuxPackageArtifact()
    sendStatus({ state: 'error', message })
  }
  throw new Error(message)
}

/**
 * Identifies the update cycle an install belongs to, so a verdict produced by a multi-second hash
 * can be dropped when a newer cycle already replaced the card it would otherwise overwrite.
 */
function getInstallCycleSignature(): string {
  const recovery = getActiveLinuxPackageRecovery()
  if (recovery) {
    return `recovery:${recovery.packageType}:${recovery.version}`
  }
  return currentStatus.state === 'downloaded'
    ? `downloaded:${currentStatus.version}`
    : `state:${currentStatus.state}`
}

/**
 * Re-proves the retained package before the install starts. Returns false when the install must be
 * abandoned; the artifact is only re-read here, so callers still own every teardown decision.
 */
async function proveRetainedLinuxPackage(pendingVersion: string): Promise<boolean> {
  const artifact = getTrackedLinuxPackageArtifact()
  if (!artifact) {
    return true
  }
  // Why: an artifact retained from another cycle says nothing about the file electron-updater is
  // about to install, so proving it would block a legitimate install on an unrelated digest.
  if (pendingVersion && pendingVersion !== artifact.version) {
    return true
  }
  const recovery = getActiveLinuxPackageRecovery()
  const cycle = getInstallCycleSignature()
  const reason = await revalidateRetainedLinuxPackage(artifact)
  if (!reason) {
    return true
  }
  reportLinuxPackageRevalidationFailure({ artifact, recovery, reason, cycle })
  return false
}

/** The failing reason, or null when the retained package still matches its release digest. */
async function revalidateRetainedLinuxPackage(
  artifact: LinuxPackageArtifact
): Promise<LinuxPackageRecoveryUnavailableReason | null> {
  linuxPackageRevalidationInFlight = true
  try {
    const verdict = await revalidateLinuxPackageForInstall(artifact)
    return verdict.ok ? null : verdict.reason
  } catch (error) {
    recordUpdaterLifecycle(
      'linux_package_revalidation_errored',
      { errorType: error instanceof Error ? error.name : typeof error },
      { level: 'warn', message: 'Could not re-verify the retained update package' }
    )
    // Why: fail closed — bytes we could not read are bytes we cannot hand to a root installer.
    return 'read-failed'
  } finally {
    // Why: the invariant every install path depends on — a wedged flag would make quitAndInstall
    // early-return for the rest of the session.
    linuxPackageRevalidationInFlight = false
  }
}

function reportLinuxPackageRevalidationFailure({
  artifact,
  recovery,
  reason,
  cycle
}: {
  artifact: LinuxPackageArtifact
  recovery: LinuxPackageInstallRecovery | null
  reason: LinuxPackageRecoveryUnavailableReason
  cycle: string
}): void {
  recordUpdaterLifecycle(
    'linux_package_revalidation_failed',
    {
      action: recovery ? 'retry-automatic' : 'restart-to-install',
      packageType: artifact.packageType,
      version: artifact.version,
      reason
    },
    { level: 'warn', message: 'Retained update package failed its pre-install digest check' }
  )
  // Why: a package proven bad must not stay tracked, but a download that landed during the hash
  // owns the slot now and destroying it would force a needless 160 MB redownload.
  const clearsArtifact = RECOVERY_CLEARING_REASONS.includes(reason)
  if (clearsArtifact && getTrackedLinuxPackageArtifact() === artifact) {
    clearTrackedLinuxPackageArtifact()
  }
  // Why: same reasoning as failLinuxPackageRecovery — a verdict from a cycle that has since been
  // replaced must not clobber whatever card the user is looking at now.
  if (getInstallCycleSignature() !== cycle) {
    return
  }
  sendInstallFailureStatus({
    state: 'error',
    message: LINUX_PACKAGE_RECOVERY_MESSAGES[reason],
    // Why: an unreadable file is not evidence the bytes changed, so the recovery card and its
    // Copy/Show actions survive a transient I/O failure exactly as they do elsewhere.
    ...(recovery && !clearsArtifact ? { recovery } : {})
  })
}

export async function getLinuxPackageInstallInstructions(): Promise<LinuxPackageInstallInstructions> {
  const recovery = getActiveLinuxPackageRecovery()
  if (!recovery) {
    throw new Error('No package install recovery is available.')
  }
  recordUpdaterLifecycle('linux_package_recovery_requested', {
    action: 'copy-command',
    packageType: recovery.packageType,
    version: recovery.version
  })
  const result = await resolveLinuxPackageInstallInstructions(recovery)
  if (!result.ok) {
    // Why: the renderer must distinguish "this machine has no package manager" (keep the card, promote
    // Show Package) from "the artifact is gone" (recovery is cleared and the card unmounts).
    if (result.reason === 'no-sudo' || result.reason === 'no-package-manager') {
      recordLinuxPackageRecoveryUnavailable(recovery, result.reason)
      return {
        ok: false,
        reason: result.reason,
        message: LINUX_PACKAGE_RECOVERY_MESSAGES[result.reason]
      }
    }
    failLinuxPackageRecovery(recovery, result.reason)
  }
  return { ok: true, command: result.command, packageFileName: result.packageFileName }
}

export async function showLinuxPackage(): Promise<void> {
  const recovery = getActiveLinuxPackageRecovery()
  if (!recovery) {
    throw new Error('No package install recovery is available.')
  }
  recordUpdaterLifecycle('linux_package_recovery_requested', {
    action: 'show-package',
    packageType: recovery.packageType,
    version: recovery.version
  })
  const result = await revealLinuxPackage(recovery)
  if (!result.ok) {
    failLinuxPackageRecovery(recovery, result.reason)
  }
}

export function quitAndInstall(): void {
  if (
    localBuildSelectionInProgress ||
    pinnedBuildSelectionInProgress ||
    pendingQuitAndInstallTimer ||
    quitAndInstallInProgress ||
    // Why: the quit timer is already cleared while the pre-install digest re-proof streams, so
    // without this a second click would schedule a parallel install of the same package.
    linuxPackageRevalidationInFlight
  ) {
    return
  }

  const retriedRecovery = getActiveLinuxPackageRecovery()
  if (retriedRecovery) {
    recordUpdaterLifecycle('linux_package_recovery_requested', {
      action: 'retry-automatic',
      packageType: retriedRecovery.packageType,
      version: retriedRecovery.version
    })
  }

  if (deferHeadlessServeInstall('install', getPendingInstallVersion())) {
    return
  }

  if (
    deferMacQuitUntilInstallerReady(
      currentStatus,
      hasInstallableDownloadedVersion(),
      getPendingInstallVersion,
      sendStatus
    )
  ) {
    return
  }

  // Why: defer the quit a tick so the renderer can flush dismissals/state before windows start closing.
  pendingQuitAndInstallTimer = setTimeout(() => {
    void performQuitAndInstall()
  }, QUIT_AND_INSTALL_DELAY_MS)
}

async function checkForUpdateNudge(): Promise<void> {
  if (!app.isPackaged || is.dev) {
    return
  }
  if (nudgeCheckInFlight) {
    return
  }

  const now = Date.now()
  if (now - lastNudgeCheckAt < NUDGE_ACTIVATION_COOLDOWN_MS) {
    return
  }
  lastNudgeCheckAt = now

  nudgeCheckInFlight = true
  try {
    const nudge = await fetchNudge()
    if (!nudge) {
      return
    }

    if (currentStatus.state === 'checking' || currentStatus.state === 'downloading') {
      return
    }

    const appVersion = app.getVersion()
    const pendingUpdateNudgeId = _getPendingUpdateNudgeId?.() ?? null
    const dismissedUpdateNudgeId = _getDismissedUpdateNudgeId?.() ?? null

    if (
      shouldApplyNudge({
        nudge,
        appVersion,
        pendingUpdateNudgeId,
        dismissedUpdateNudgeId
      })
    ) {
      awaitingNudgeCheckOutcome = true
      _setPendingUpdateNudgeId?.(nudge.id)
      mainWindowRef?.webContents.send('updater:clearDismissal')
      runBackgroundUpdateCheck(nudge.id)
    }
  } finally {
    nudgeCheckInFlight = false
  }
}

function scheduleUpdateNudgeCheck(): void {
  if (nudgeCheckTimer) {
    clearTimeout(nudgeCheckTimer)
  }
  nudgeCheckTimer = setTimeout(() => {
    void checkForUpdateNudge()
    scheduleUpdateNudgeCheck()
  }, NUDGE_POLL_INTERVAL_MS)
}

export function dismissNudge(): void {
  const pendingId = activeUpdateNudgeId ?? _getPendingUpdateNudgeId?.() ?? null
  if (pendingId) {
    _setDismissedUpdateNudgeId?.(pendingId)
    clearPendingUpdateNudge()
  }
}

/**
 * The user closed an offered update without taking it. For a local build or a
 * pinned dev jump that ends the session: nothing will consume that feed now, so
 * release checks must stop being deferred.
 */
export function dismissAvailableUpdate(): void {
  if (activeUpdateSource === 'release' && !isPinnedBuildActive) {
    return
  }
  if (localBuildSelectionInProgress || pinnedBuildSelectionInProgress) {
    return
  }
  // Why: only an un-acted 'available' card is abandoned — 'downloading'/'downloaded' still need the pinned feed and allowDowngrade.
  if (currentStatus.state !== 'available') {
    return
  }
  clearAvailableUpdateContext()
  restoreReleaseUpdateSource()
  // Why: leaving the card's 'available' status behind would let a retry download the local version off the restored release feed.
  sendStatus({ state: 'idle' })
}

export function setupAutoUpdater(
  mainWindow: BrowserWindow,
  opts?: {
    getLastUpdateCheckAt?: () => number | null
    onBeforeQuit?: () => void | Promise<void>
    setLastUpdateCheckAt?: (timestamp: number) => void
    getPendingUpdateNudgeId?: () => string | null
    getDismissedUpdateNudgeId?: () => string | null
    setPendingUpdateNudgeId?: (id: string | null) => void
    setDismissedUpdateNudgeId?: (id: string | null) => void
    getReleaseChannelOverride?: () => ReleaseChannel | null
    installMode?: UpdateInstallMode
  }
): void {
  mainWindowRef = mainWindow
  onBeforeQuitCleanup = opts?.onBeforeQuit ?? null
  persistLastUpdateCheckAt = opts?.setLastUpdateCheckAt ?? null
  _getLastUpdateCheckAt = opts?.getLastUpdateCheckAt ?? null
  _getPendingUpdateNudgeId = opts?.getPendingUpdateNudgeId ?? null
  _getDismissedUpdateNudgeId = opts?.getDismissedUpdateNudgeId ?? null
  _setPendingUpdateNudgeId = opts?.setPendingUpdateNudgeId ?? null
  _setDismissedUpdateNudgeId = opts?.setDismissedUpdateNudgeId ?? null
  getReleaseChannelOverride = opts?.getReleaseChannelOverride ?? null
  updateInstallMode = opts?.installMode ?? 'interactive'
  lastInstallDeferralVersion = { download: null, install: null }

  const serveHandoffFailure = getServeUpdateHandoffFailure()
  if (serveHandoffFailure) {
    recordUpdaterLifecycle(
      'headless_serve_handoff_failed',
      { reason: serveHandoffFailure },
      { level: 'warn', message: 'Supervised serve update did not complete' }
    )
    sendErrorStatus(`The server update did not complete: ${serveHandoffFailure}`, true)
  }

  if (!app.isPackaged && !is.dev) {
    return
  }
  if (is.dev) {
    return
  }

  const autoUpdater = getAutoUpdater()
  autoUpdater.autoDownload = false
  if (activeUpdateSource === 'release') {
    autoUpdater.allowDowngrade = false
    autoUpdater.disableDifferentialDownload = false
  }
  // Why: supervised serve installs require an explicit handoff; ordinary service quits must never install implicitly.
  // Root Linux packages also opt out: an implicit quit-time escalation would fail after the UI is gone, leaving no recovery surface.
  autoUpdater.autoInstallOnAppQuit =
    updateInstallMode === 'interactive' && getLinuxRootPackageType() === null
  // Why: MacUpdater ignores quitAndInstall arguments; the surviving CLI supervisor must be the only serve relaunch owner.
  autoUpdater.autoRunAppAfterInstall = updateInstallMode === 'interactive'

  // Why: our only on-machine window into electron-updater; otherwise an unexpected update-not-available or failed fetch is invisible.
  // The adapter also retains the redacted child stderr that BaseUpdater logs but drops from the 'error' event.
  autoUpdater.logger = createUpdaterDiagnosticLogger() as never

  // Security: never re-add a verifyUpdateCodeSignature override — a no-op disables electron-updater's built-in Authenticode check and accepts any installer.

  // Why: generic provider avoids the native GitHub provider's RC-channel filtering; per-check repinning to a concrete /releases/download/<tag>/ URL avoids /latest redirect drift between check and download.
  if (activeUpdateSource === 'release') {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: 'https://github.com/zpyoung/orca/releases/latest/download'
    })
  }

  if (autoUpdaterInitialized) {
    return
  }
  autoUpdaterInitialized = true

  registerAutoUpdaterHandlers({
    autoUpdater,
    clearAvailableUpdateContext,
    consumeMissingManifestPrereleaseFallbackResult,
    getMissingManifestPrereleaseFallbackUserInitiated,
    getPublishingWindowLastGoodCheck,
    getActiveUpdateCheckEventAttemptId,
    getCurrentStatus: () => currentStatus,
    getKnownReleaseUrl,
    getPendingInstallVersion,
    getUserInitiatedCheck: () => userInitiatedCheck,
    handleQuitAndInstallFailure,
    isQuitAndInstallHandoffActive,
    hasInstallableDownloadedVersion,
    isLocalBuildCheck: () => activeUpdateSource === 'local',
    // Why: pinned jumps are deliberate, so update-available/-downloaded must not
    // reject them for being older than the running version.
    isPinnedBuildCheck: () => isPinnedBuildActive,
    shouldHandleUpdaterErrorEvent,
    performQuitAndInstall,
    clearUpdateAvailableEventPending,
    isActiveUpdateCheckAttempt,
    markUpdateCheckEventAttempt,
    markUpdateAvailableEventPending,
    sendCheckFailureStatus,
    sendErrorStatus,
    markMissingManifestPrereleaseFallbackChecking,
    shouldDeferMacQuitForInstall: () => updateInstallMode === 'interactive',
    shouldSuppressMissingManifestPrereleaseFallbackEvent,
    suppressMissingManifestPrereleaseFallbackPromiseFailure,
    recordCompletedUpdateCheck,
    restoreReleaseUpdateSource,
    sendStatus,
    scheduleAutomaticUpdateCheck,
    clearBackgroundCheckLaunchPending,
    setAvailableReleaseUrl: (releaseUrl) => {
      availableReleaseUrl = releaseUrl
    },
    setAvailableVersion: (version) => {
      availableVersion = version
    },
    setUserInitiatedCheck: (value) => {
      userInitiatedCheck = value
    }
  })

  void checkForUpdateNudge()
  scheduleUpdateNudgeCheck()

  const checkDailyOnWake = () => {
    void checkForUpdateNudge()
    if (
      backgroundCheckLaunchPending ||
      currentStatus.state === 'checking' ||
      currentStatus.state === 'downloading'
    ) {
      return
    }
    const lastCheck = _getLastUpdateCheckAt?.() ?? null
    const msSince = lastCheck === null ? Number.POSITIVE_INFINITY : Date.now() - lastCheck
    if (msSince >= AUTO_UPDATE_CHECK_INTERVAL_MS) {
      runBackgroundUpdateCheck()
      scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
    }
  }

  powerMonitor.on('resume', checkDailyOnWake)
  app.on('browser-window-focus', checkDailyOnWake)

  const lastUpdateCheckAt = opts?.getLastUpdateCheckAt?.() ?? null
  const msSinceLastCheck =
    lastUpdateCheckAt === null ? Number.POSITIVE_INFINITY : Date.now() - lastUpdateCheckAt

  if (msSinceLastCheck >= AUTO_UPDATE_CHECK_INTERVAL_MS) {
    runBackgroundUpdateCheck()
    scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS)
  } else {
    scheduleAutomaticUpdateCheck(AUTO_UPDATE_CHECK_INTERVAL_MS - msSinceLastCheck)
  }
}

export function downloadUpdate(): void {
  updater.downloadUpdate()
}

export function quitAndInstall(): void {
  updater.quitAndInstall()
}

export function isQuittingForUpdate(): boolean {
  return updater.isQuittingForUpdate()
}

export async function getLinuxPackageInstallInstructions(): Promise<LinuxPackageInstallInstructions> {
  return updater.getLinuxPackageInstallInstructions()
}

export async function showLinuxPackage(): Promise<void> {
  return updater.showLinuxPackage()
}

export async function listAvailableReleaseBuilds(channel: ReleaseChannel): Promise<ReleaseBuild[]> {
  return updater.listAvailableReleaseBuilds(channel)
}

export function dismissNudge(): void {
  updater.dismissNudge()
}

export function dismissAvailableUpdate(): void {
  updater.dismissAvailableUpdate()
}

export function setupAutoUpdater(mainWindow: BrowserWindow, opts?: UpdaterSetupOptions): void {
  updater.setupAutoUpdater(mainWindow, opts)
}
