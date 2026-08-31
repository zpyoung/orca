import { ipcMain, type BrowserWindow } from 'electron'
import type { Store } from '../persistence'
import { SshConnectionStore } from '../ssh/ssh-connection-store'
import { SshConnectionManager } from '../ssh/ssh-connection-manager'
import type { SshRelayAiVaultHostInfo } from '../ssh/ssh-relay-session'
import type {
  SshAiVaultRelayListParams,
  SshAiVaultRelayTitleParams
} from '../../shared/ssh-ai-vault-relay'
import type { NativeChatRelayPing } from '../../shared/fork-native-chat-relay/native-chat-relay-protocol'
import {
  notifySshRelayReady,
  onSshRelayReady
} from './fork-native-chat-relay/ssh-relay-ready-notifier'
import {
  onActiveSshNativeChatChangedFromSessions,
  requestActiveSshNativeChatFromSessions
} from './fork-native-chat-relay/ssh-native-chat-api'
import { SshPortForwardManager } from '../ssh/ssh-port-forward'
import { isRuntimeOwnedSshTargetId } from '../../shared/execution-host'
import { quitTeardownStartGate } from '../quit-teardown-start-gate'
import {
  getSshTargetRegistryStore,
  setSshConnectionManagerResolver,
  setSshTargetRegistryHandlers,
  setSshTargetRegistryStore
} from '../ssh/ssh-target-registry'

// Why re-exported: the registry moved to ../ssh/ssh-target-registry so the runtime can
// read it without pulling ipcMain in, but many existing importers reference these from
// here. Re-exporting keeps them working without a repo-wide rename.
export {
  connectRegisteredSshTarget,
  getActiveMultiplexer,
  getRegisteredSshState,
  getSshConnectionManager,
  listRegisteredRemovedSshTargetLabels,
  listRegisteredSshTargets
} from '../ssh/ssh-target-registry'
import { registerSshBrowseHandler } from './ssh-browse'
import { registerCredentialHandler } from './ssh-passphrase'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  initializeSshConnectionGenerationSession,
  resetSshConnectionGenerations
} from '../ssh/ssh-connection-generation'
import { resetSshProviderAuthorities } from '../ssh/ssh-provider-authority'
import { activeSessions } from './ssh-active-relay-sessions'
import {
  registerAdvertisedUrlRefresh,
  unregisterAdvertisedUrlRefresh
} from './ssh-advertised-url-refresh'
import {
  connectInFlight,
  credentialRequestedForTarget,
  pendingTransportReconnects,
  resetRelayInFlight,
  testConnectionProbes,
  testingTargets
} from './ssh-connect-attempt-registry'
import { createSshConnectionCallbacks } from './ssh-connection-state-callbacks'
import { registerSshConnectionHandlers } from './ssh-connection-handlers'
import {
  registerPowerMonitorReconnect,
  unregisterPowerMonitorReconnect
} from './ssh-host-sleep-reconnect'
import {
  connectionManager,
  getCurrentMainWindow,
  portForwardManager,
  setConnectionManager,
  setCurrentGetMainWindow,
  setCurrentRuntime,
  setPersistedStore,
  setPortForwardManager
} from './ssh-ipc-context'
import { registerSshPortForwardHandlers } from './ssh-port-forward-handlers'
import { persistPortForwardsWithUnrestored } from './ssh-port-forward-persistence'
import { clearRelayLostBackoff, relayLostBackoff } from './ssh-relay-lost-backoff'
import { refreshActiveRelaySessions } from './ssh-relay-session-callbacks'
import { broadcastPortForwards, relayStateOverrides } from './ssh-renderer-broadcast'
import { resetSshShutdownDrain } from './ssh-shutdown-drain'
import { registerSshTargetCrudHandlers } from './ssh-target-crud-handlers'
import { targetLifecycleInFlight } from './ssh-target-lifecycle-queue'

const SSH_IPC_CHANNELS = [
  'ssh:listTargets',
  'ssh:listRemovedTargetLabels',
  'ssh:addTarget',
  'ssh:updateTarget',
  'ssh:removeTarget',
  'ssh:importConfig',
  'ssh:listConfigHosts',
  'ssh:resolveConfigHost',
  'ssh:connect',
  'ssh:disconnect',
  'ssh:terminateSessions',
  'ssh:resetRelay',
  'ssh:getState',
  'ssh:needsPassphrasePrompt',
  'ssh:testConnection',
  'ssh:addPortForward',
  'ssh:updatePortForward',
  'ssh:removePortForward',
  'ssh:listPortForwards',
  'ssh:listDetectedPorts'
] as const

export function getActiveSshAiVaultHostInfo(targetId: string): SshRelayAiVaultHostInfo | null {
  if (isRuntimeOwnedSshTargetId(targetId)) {
    return null
  }
  return activeSessions.get(targetId)?.getAiVaultHostInfo() ?? null
}

export function getActiveSshAiVaultHostInfos(): SshRelayAiVaultHostInfo[] {
  return [...activeSessions.values()].flatMap((session) => {
    if (isRuntimeOwnedSshTargetId(session.targetId)) {
      return []
    }
    const info = session.getAiVaultHostInfo()
    return info ? [info] : []
  })
}

export async function requestActiveSshAiVaultSessionList(
  targetId: string,
  params: SshAiVaultRelayListParams,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<unknown> {
  if (isRuntimeOwnedSshTargetId(targetId)) {
    return null
  }
  const session = activeSessions.get(targetId)
  if (!session) {
    throw new Error('SSH relay is not ready')
  }
  return session.requestAiVaultSessionList(params, options)
}

export async function requestActiveSshAiVaultSessionTitles(
  targetId: string,
  params: SshAiVaultRelayTitleParams,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<unknown> {
  if (isRuntimeOwnedSshTargetId(targetId)) {
    return null
  }
  const session = activeSessions.get(targetId)
  if (!session) {
    throw new Error('SSH relay is not ready')
  }
  return session.requestAiVaultSessionTitles(params, options)
}

/** Issue a native-chat relay request against a plain (non runtime-owned) SSH
 *  target. Runtime-owned targets reach their transcripts over runtime RPC. */
export async function requestActiveSshNativeChat(
  targetId: string,
  method: string,
  params: Record<string, unknown>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<unknown> {
  return requestActiveSshNativeChatFromSessions(activeSessions, targetId, method, params, options)
}

export function onActiveSshNativeChatChanged(
  targetId: string,
  handler: (ping: NativeChatRelayPing) => void
): () => void {
  return onActiveSshNativeChatChangedFromSessions(activeSessions, targetId, handler)
}

/** Fires each time the target's relay reaches ready. A reconnect reaps every
 *  relay-side native-chat subscription, and an idle pane issues no request that
 *  would discover that, so subscribers re-establish from this signal. */
export function onActiveSshRelayReady(targetId: string, handler: () => void): () => void {
  return onSshRelayReady(targetId, handler)
}

function runTargetLifecycle(targetId: string, operation: () => Promise<void>): Promise<void> {
  const prior = targetLifecycleInFlight.get(targetId)
  const operationPromise = (async () => {
    if (prior) {
      await prior.catch(() => undefined)
    }
    await operation()
  })()
  let trackedPromise!: Promise<void>
  trackedPromise = operationPromise.finally(() => {
    if (targetLifecycleInFlight.get(targetId) === trackedPromise) {
      targetLifecycleInFlight.delete(targetId)
    }
  })
  targetLifecycleInFlight.set(targetId, trackedPromise)
  return trackedPromise
}

async function awaitTargetLifecycle(targetId: string): Promise<void> {
  while (true) {
    const lifecycle = targetLifecycleInFlight.get(targetId)
    if (!lifecycle) {
      return
    }
    await lifecycle.catch(() => undefined)
  }
}

async function teardownSshTargetTransport(
  targetId: string,
  teardown: (session: SshRelaySession) => void | Promise<void>
): Promise<void> {
  let transportDisconnect: Promise<{ ok: true } | { ok: false; error: unknown }>
  try {
    transportDisconnect = Promise.resolve(connectionManager?.disconnect(targetId)).then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const
    )
  } catch (error) {
    transportDisconnect = Promise.resolve({ ok: false, error })
  }
  const sessionTeardown = teardownActiveSshSession(targetId, teardown).then(
    () => ({ ok: true }) as const,
    (error: unknown) => ({ ok: false, error }) as const
  )
  const [disconnectResult, teardownResult] = await Promise.all([
    transportDisconnect,
    sessionTeardown
  ])
  if (!teardownResult.ok) {
    throw teardownResult.error
  }
  if (!disconnectResult.ok) {
    throw disconnectResult.error
  }
}

async function teardownActiveSshSession(
  targetId: string,
  teardown: (session: SshRelaySession) => void | Promise<void>
): Promise<void> {
  const session = activeSessions.get(targetId)
  if (!session) {
    return
  }
  let teardownError: { error: unknown } | null = null
  try {
    // Why: await port teardown so local listeners are released before disconnect/remove completes, else an immediate reconnect hits EADDRINUSE.
    await portForwardManager?.removeAllForwards(targetId)
  } catch (error) {
    teardownError = { error }
  }
  try {
    await teardown(session)
  } catch (error) {
    teardownError ??= { error }
  }
  if (activeSessions.get(targetId) === session) {
    activeSessions.delete(targetId)
    clearRelayLostBackoff(targetId)
    clearRelayStateOverride(targetId)
  }
  if (teardownError) {
    throw teardownError.error
  }
}

// Why: a dropped session must detach, not just leave activeSessions — detach releases the SSH PTY
// consumer identity so the next connect reclaims its owner lease instead of minting a new one.
// Why awaited, and why the map entry outlives the await: a retry can start the moment this returns,
// so it must either find the session (and await this same latched teardown at the existing-session
// path) or find nothing because the 'detached' lease write is already durable. Deleting first lets a
// fast reconnect mark leases 'attached' and then have this session's late 'detached' write clobber it.
async function abandonFailedSshSession(targetId: string, session: SshRelaySession): Promise<void> {
  // Why: detachAndPersist transitions recovery ownership synchronously; only durability is awaited.
  try {
    await session.detachAndPersist()
  } catch (error) {
    // Why: a teardown throw must not mask the connect error the caller is about to rethrow.
    console.warn(
      `[ssh] Failed to detach abandoned session for ${targetId}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (activeSessions.get(targetId) === session) {
    activeSessions.delete(targetId)
  }
}

// Why: a connect cancelled after its transport already opened still owns that transport and its
// unpublished session — nothing else will reach them, so it has to close them itself. Why only the
// connection it minted, and by identity: disconnecting by target id (or closing a transport it merely
// reused) would tear down the replacement connect's live transport.
async function abandonCancelledConnectAttempt(
  targetId: string,
  session: SshRelaySession,
  mintedConnection: SshConnection | null
): Promise<void> {
  // Why the identity guard: every path that removes a session from activeSessions detaches it first,
  // so re-detaching a superseded session would only clobber the replacement's lease state.
  if (activeSessions.get(targetId) === session) {
    await abandonFailedSshSession(targetId, session)
  }
  if (!mintedConnection) {
    return
  }
  try {
    await connectionManager!.disconnectConnection(targetId, mintedConnection)
  } catch (error) {
    // Why: the caller is about to throw the cancellation; a teardown throw must not replace it.
    console.warn(
      `[ssh] Failed to disconnect cancelled connect transport for ${targetId}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function relayGracePeriodForTarget(target: SshTarget | null | undefined): number | undefined {
  return target?.relayGracePeriodSeconds
}

// Why: tabs must share one connect, while a disconnect must invalidate that
// attempt so its late continuation cannot clobber a replacement.
type ConnectAttempt = {
  authority: DirectSshAuthority
  promise: Promise<SshConnectionState>
}

const connectInFlight = new Map<string, ConnectAttempt>()
const pendingTransportReconnects = new Set<string>()

// Why the quit gate rather than a local latch: "the committed quit has begun" already has an owner,
// and a private copy could be set by something that is not actually quitting — leaving SSH connects
// refused for the rest of the process lifetime.
function assertSshConnectsNotFenced(): void {
  if (quitTeardownStartGate.hasStarted()) {
    throw new Error('SSH connects are closed for app shutdown')
  }
}

function invalidateConnectAttempt(targetId: string): void {
  rotateSshProviderAuthority(targetId)
  pendingTransportReconnects.delete(targetId)
  connectInFlight.delete(targetId)
  credentialRequestedForTarget.delete(targetId)
}

function isCurrentConnectAttempt(targetId: string, authority: DirectSshAuthority): boolean {
  return authority.targetId === targetId && isCurrentSshProviderAuthority(authority)
}

// Why: publish reset's teardown/force-stop/disconnect lifecycle so new connects and duplicate resets can't race it.
const resetRelayInFlight = new Map<string, Promise<void>>()

// Why: ssh:testConnection connects then disconnects; suppressing broadcasts during the test avoids worktree cards flashing connected → disconnected.
const testingTargets = new Set<string>()
const testConnectionProbes = new Set<Promise<unknown>>()

// Why: without backoff, a relay channel that keeps dying reconnects as fast as the network allows, hammering local + remote sshd; track attempts and back off to end the loop recoverably.
type RelayLostBackoffState = {
  attempts: number
  reconnectTimer: ReturnType<typeof setTimeout> | null
  stabilizedTimer: ReturnType<typeof setTimeout> | null
}
const relayLostBackoff = new Map<string, RelayLostBackoffState>()
const relayStateOverrides = new Map<string, SshConnectionState>()
const RELAY_LOST_MAX_ATTEMPTS = 6
const RELAY_LOST_BASE_DELAY_MS = 500
const RELAY_LOST_MAX_DELAY_MS = 15_000
// Why: a reconnect whose mux dies within this window was a flap, not a recovery — don't reset the attempt counter. 5s covers provider re-registration + PTY reattach.
const RELAY_LOST_STABILIZED_MS = 5_000
// Why: transport states the SSH ladder never leaves on its own — waiting for a relay redeploy past one of these is an unbounded loop.
const TRANSPORT_TERMINAL_STATUSES = new Set<SshConnectionStatus>([
  'disconnected',
  'auth-failed',
  'reconnection-failed',
  'error'
])

function clearRelayLostBackoff(targetId: string): void {
  const state = relayLostBackoff.get(targetId)
  if (state?.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
  }
  if (state?.stabilizedTimer) {
    clearTimeout(state.stabilizedTimer)
  }
  relayLostBackoff.delete(targetId)
}

function broadcastSshState(
  getMainWindow: () => BrowserWindow | null,
  targetId: string,
  state: SshConnectionState
): void {
  // Why: runtime-owned (ephemeral-VM) targets are hidden from the renderer, so broadcasting their state only triggers wasted listTargets() lookups.
  if (isRuntimeOwnedSshTargetId(targetId)) {
    currentRuntime?.invalidateSshWorktreeScanCache?.(targetId)
    return
  }
  const enrichedState = withSshRemotePlatform(targetId, state)
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('ssh:state-changed', { targetId, state: enrichedState })
  }
  // Why: paired remote clients have no ssh:state-changed IPC; without this their terminals keep a stale reconnect overlay.
  currentRuntime?.notifySshStateChanged?.(targetId, enrichedState)
}

function withSshRemotePlatform(targetId: string, state: SshConnectionState): SshConnectionState {
  const remotePlatform = activeSessions.get(targetId)?.getHostPlatform()?.os
  const authority = getSshProviderAuthority(targetId)
  return {
    ...state,
    targetId,
    providerEpoch: authority.providerEpoch,
    connectionGeneration: authority.connectionGeneration,
    ...(remotePlatform ? { remotePlatform } : {})
  }
}

function publishRelayOverride(
  getMainWindow: () => BrowserWindow | null,
  targetId: string,
  status: SshConnectionStatus,
  error: string | null,
  reconnectAttempt: number
): void {
  const state = withSshRemotePlatform(targetId, { targetId, status, error, reconnectAttempt })
  relayStateOverrides.set(targetId, state)
  broadcastSshState(getMainWindow, targetId, state)
}

function clearRelayStateOverride(targetId: string): void {
  relayStateOverrides.delete(targetId)
}

function connectionSupportsFolderDownload(targetId: string): boolean {
  // Why: connections without an explicit transport are ssh2-shaped; only a confirmed system-SSH transport lacks the SFTP-only capability.
  return connectionManager?.getConnection(targetId)?.usesSystemSshTransport?.() !== true
}

function getPublicSshState(targetId: string): SshConnectionState | undefined {
  const state = relayStateOverrides.get(targetId) ?? connectionManager!.getState(targetId)
  return state ? withSshRemotePlatform(targetId, state) : undefined
}

function broadcastPortForwards(getMainWindow: () => BrowserWindow | null, targetId: string): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    return
  }
  win.webContents.send('ssh:port-forwards-changed', {
    targetId,
    forwards: listForwardsEnriched(targetId)
  })
}

function broadcastDetectedPorts(
  getMainWindow: () => BrowserWindow | null,
  targetId: string,
  ports: DetectedPort[],
  options?: Parameters<typeof enrichSshDetectedPorts>[3]
): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) {
    return
  }
  win.webContents.send('ssh:detected-ports-changed', {
    targetId,
    ports: enrichDetected(targetId, ports, options)
  })
}

function listForwardsEnriched(targetId: string): ReturnType<SshPortForwardManager['listForwards']> {
  const raw = portForwardManager!.listForwards(targetId)
  if (!persistedStore) {
    return raw
  }
  return enrichSshForwardEntries(raw, getWorktreeIdsForConnection(persistedStore, targetId))
}

function enrichDetected(
  targetId: string,
  ports: DetectedPort[],
  options?: Parameters<typeof enrichSshDetectedPorts>[3]
): EnrichedDetectedPort[] {
  if (!persistedStore) {
    return ports
  }
  return enrichSshDetectedPorts(
    ports,
    getWorktreeIdsForConnection(persistedStore, targetId),
    undefined,
    options
  )
}

// Why: after user add/remove/update the runtime manager is the source of truth — persist exactly its entries (unrestored ones handled by a separate helper).
function persistPortForwards(targetId: string): void {
  const active = portForwardManager!.listForwards(targetId)
  const saved: SavedPortForward[] = active.map((f) => ({
    localPort: f.localPort,
    remoteHost: f.remoteHost,
    remotePort: f.remotePort,
    label: f.label
  }))
  getSshTargetRegistryStore()!.updateTarget(targetId, {
    portForwards: saved.length > 0 ? saved : undefined
  })
}

// Why: keep forwards that failed to restore in the persisted list so they retry on next reconnect instead of being silently dropped.
function persistPortForwardsWithUnrestored(targetId: string): void {
  const active = portForwardManager!.listForwards(targetId)
  const activeKeys = new Set(active.map((f) => `${f.localPort}:${f.remoteHost}:${f.remotePort}`))

  const existing = getSshTargetRegistryStore()!.getTarget(targetId)?.portForwards ?? []
  const unrestored = existing.filter(
    (pf) => !activeKeys.has(`${pf.localPort}:${pf.remoteHost}:${pf.remotePort}`)
  )

  const saved: SavedPortForward[] = [
    ...active.map((f) => ({
      localPort: f.localPort,
      remoteHost: f.remoteHost,
      remotePort: f.remotePort,
      label: f.label
    })),
    ...unrestored
  ]
  getSshTargetRegistryStore()!.updateTarget(targetId, {
    portForwards: saved.length > 0 ? saved : undefined
  })
}

async function restorePortForwards(
  targetId: string,
  getMainWindow: () => BrowserWindow | null
): Promise<void> {
  const target = getSshTargetRegistryStore()!.getTarget(targetId)
  if (!target?.portForwards?.length) {
    return
  }
  const conn = connectionManager!.getConnection(targetId)
  if (!conn) {
    return
  }

  // Why: keep failed restores in persisted state — a failure may be transient (port temporarily busy), so retry on next reconnect.
  for (const saved of target.portForwards) {
    // Why: a reconnect mid-loop swaps the connection object; bail on identity change so we don't add forwards to a stale conn (leaking listeners).
    if (connectionManager!.getConnection(targetId) !== conn) {
      return
    }
    try {
      await portForwardManager!.addForward(
        targetId,
        conn,
        saved.localPort,
        saved.remoteHost,
        saved.remotePort,
        saved.label
      )
    } catch (err) {
      console.warn(
        `[ssh] Failed to restore forward :${saved.localPort} → ${saved.remoteHost}:${saved.remotePort}: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  persistPortForwardsWithUnrestored(targetId)
  broadcastPortForwards(getMainWindow, targetId)
}

function registerAdvertisedUrlRefresh(getMainWindow: () => BrowserWindow | null): void {
  advertisedUrlWatcherUnsubscribe?.()
  // Why: SSH port scans only emit on raw host/port/PID changes, but a terminal can print the advertised URL later, so the watcher must also refresh the renderer.
  advertisedUrlWatcherUnsubscribe = advertisedUrlWatcher.onDidChange(({ worktreeId }) => {
    if (!persistedStore) {
      return
    }
    for (const targetId of getConnectionIdsForWorktree(persistedStore, worktreeId)) {
      const session = activeSessions.get(targetId)
      if (!session) {
        continue
      }
      const scanner = session.getPortScanner()
      if (scanner) {
        // Why: watcher changes can arrive before the next SSH scan refreshes listener PIDs, so don't validate PIDs against cached scanner rows.
        broadcastDetectedPorts(getMainWindow, targetId, scanner.getDetectedPorts(targetId), {
          validatePid: false
        })
      }
      broadcastPortForwards(getMainWindow, targetId)
    }
  })
}

// Why: macOS can resume before the network is back, so a failed first probe gets one retry before the link is declared dead (#7773).
const RESUME_PROBE_TIMEOUT_MS = 5_000
const RESUME_PROBE_ATTEMPTS = 2

async function isRelayLinkAliveAfterResume(session: SshRelaySession): Promise<boolean> {
  const mux = session.getMux()
  if (!mux || mux.isDisposed()) {
    return false
  }
  for (let attempt = 0; attempt < RESUME_PROBE_ATTEMPTS; attempt++) {
    if (await mux.probeLiveness(RESUME_PROBE_TIMEOUT_MS)) {
      return true
    }
  }
  return false
}

function registerPowerMonitorReconnect(): void {
  powerMonitorUnsubscribe?.()
  const onSuspend = (): void => {
    for (const session of activeSessions.values()) {
      session.prepareForHostSleep()
    }
  }
  const onResume = (): void => {
    for (const [targetId, session] of activeSessions) {
      const manager = connectionManager
      const conn = manager?.getConnection(targetId)
      if (!conn) {
        continue
      }
      void (async () => {
        // Why: unconditional reconnect on wake tore down live sessions and flashed the overlay (#7773); only reconnect if the relay link actually died during sleep.
        if (await isRelayLinkAliveAfterResume(session)) {
          return
        }
        // Why: the probe can take ~10s; bail if the session/connection was replaced or torn down meanwhile, else we'd resurrect it.
        if (activeSessions.get(targetId) !== session || manager?.getConnection(targetId) !== conn) {
          return
        }
        try {
          await manager?.reconnect(targetId)
        } catch (err) {
          console.warn(
            `[ssh] Failed to reconnect ${targetId} after system resume: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        }
      })()
    }
  }
  powerMonitor.on('suspend', onSuspend)
  powerMonitor.on('resume', onResume)
  powerMonitorUnsubscribe = () => {
    powerMonitor.off('suspend', onSuspend)
    powerMonitor.off('resume', onResume)
  }
}

function createSshConnectionCallbacks(): SshConnectionCallbacks {
  return {
    onCredentialRequest: (targetId, kind, detail) => {
      credentialRequestedForTarget.add(targetId)
      return requestCredential(getCurrentMainWindow, targetId, kind, detail)
    },
    onStateChange: (targetId: string, state: SshConnectionState) => {
      if (testingTargets.has(targetId)) {
        return
      }

      // Why: an SSH reconnect must re-deploy the relay and rebuild providers; the guard below fires only for real reconnects, not an explicit connect's 'deploying'.
      const session = activeSessions.get(targetId)
      const sessionState = session?.getState()
      const transportReconnectStarted =
        state.status === 'reconnecting' &&
        (sessionState === 'ready' || sessionState === 'reconnecting') &&
        !pendingTransportReconnects.has(targetId)
      if (transportReconnectStarted) {
        rotateSshProviderAuthority(targetId)
        pendingTransportReconnects.add(targetId)
      } else if (
        state.status === 'disconnected' ||
        state.status === 'auth-failed' ||
        state.status === 'reconnection-failed' ||
        state.status === 'error'
      ) {
        pendingTransportReconnects.delete(targetId)
      }
      const completedTransportReconnect =
        state.status === 'connected' && pendingTransportReconnects.delete(targetId)
      const shouldReconnectRelay =
        session !== undefined &&
        completedTransportReconnect &&
        state.reconnectAttempt === 0 &&
        (sessionState === 'ready' || sessionState === 'reconnecting')
      const relayReconnectAlreadyInFlight =
        !completedTransportReconnect &&
        state.status === 'connected' &&
        sessionState === 'reconnecting' &&
        relayStateOverrides.has(targetId)

      if (shouldReconnectRelay) {
        // Why: this branch redeploys the relay itself over a fresh transport, so any pending relay-lost retry is stale — dropping it also gives the new transport generation a full attempt budget.
        clearRelayLostBackoff(targetId)
        // Why: SSH connects before the relay providers rebuild; keep renderer actions gated until SshRelaySession reaches ready again.
        publishRelayOverride(
          getCurrentMainWindow,
          targetId,
          'reconnecting',
          'Relay channel reconnecting...',
          state.reconnectAttempt
        )
      } else if (relayReconnectAlreadyInFlight) {
        // Why: duplicate connected notifications belong to the same socket generation and must not expose providers before relay recovery finishes.
        return
      } else if (
        state.status === 'connected' &&
        session !== undefined &&
        sessionState !== 'ready' &&
        !completedTransportReconnect &&
        connectInFlight.has(targetId)
      ) {
        // Why: the raw SSH transport reaches 'connected' before the relay session establishes during an
        // explicit connect. Forwarding it makes the renderer treat the host as fully up — it remounts
        // SSH panes (-> window.api.ssh.connect) and fires connected-gated data reads before any provider
        // exists. On a permanent relay-deploy failure that premature 'connected' drives an unbounded
        // reconnect loop. Hold it at 'deploying-relay'; the in-flight doConnect broadcasts the
        // authoritative 'connected' directly (bypassing this callback) after establish() succeeds, or a
        // terminal state on failure. The connectInFlight gate keeps this scoped to a live connect, so a
        // stray raw 'connected' with no follow-up (e.g. a transport blip on a session left 'idle' by a
        // relay version mismatch) is never wedged at 'deploying-relay'.
        clearRelayStateOverride(targetId)
        broadcastSshState(getCurrentMainWindow, targetId, {
          targetId,
          status: 'deploying-relay',
          error: state.error,
          reconnectAttempt: state.reconnectAttempt
        })
      } else {
        clearRelayStateOverride(targetId)
        broadcastSshState(getCurrentMainWindow, targetId, state)
      }

      if (!session) {
        return
      }
      // Why: allow reconnect from both 'ready' and 'reconnecting'; without the latter, a failed relay deploy would permanently brick the session.
      if (shouldReconnectRelay) {
        const target = getSshTargetRegistryStore()?.getTarget(targetId)
        const conn = connectionManager?.getConnection(targetId)
        if (conn) {
          void session.reconnect(conn, relayGracePeriodForTarget(target))
        }
      }
    }
  }
}

function broadcastDetectedPortsFromCurrentWindow(
  targetId: string,
  ports: DetectedPort[],
  _platform: string
): void {
  broadcastDetectedPorts(getCurrentMainWindow, targetId, ports)
}

function configureRelaySessionCallbacks(session: SshRelaySession): void {
  session.setOnTerminalRelayError((tid, err) => {
    clearRelayLostBackoff(tid)
    if (activeSessions.get(tid)?.getState() !== 'deploying') {
      rotateSshProviderAuthority(tid)
    }
    console.warn(
      `[ssh] Terminal relay error for ${tid}: ${err.message}; skipping reconnect backoff.`
    )
    publishRelayOverride(getCurrentMainWindow, tid, 'error', err.message, 0)
  })

  session.setOnRelayLost((tid) => {
    const s = activeSessions.get(tid)
    if (!s) {
      return
    }
    const c = connectionManager?.getConnection(tid)
    if (!c) {
      return
    }
    const t = getSshTargetRegistryStore()?.getTarget(tid)

    // Why: bounded exponential backoff — without it, a remote bug that closes every fresh --connect channel becomes an infinite relay-deploy loop.
    const state = relayLostBackoff.get(tid) ?? {
      attempts: 0,
      reconnectTimer: null,
      stabilizedTimer: null
    }
    if (state.stabilizedTimer) {
      clearTimeout(state.stabilizedTimer)
      state.stabilizedTimer = null
    }
    if (state.reconnectTimer) {
      return
    }
    rotateSshProviderAuthority(tid)

    // Why: re-deploying the relay rides the SSH transport, so while the transport is itself down no attempt
    // can succeed. Waiting at the max delay without consuming the budget keeps a flapping host off the
    // manual-reconnect banner, which would tell the user to act on a link that is still auto-recovering.
    const transportStatus = connectionManager?.getState(tid)?.status
    const transportConnected = transportStatus === 'connected'
    if (transportConnected && state.attempts >= RELAY_LOST_MAX_ATTEMPTS) {
      console.warn(
        `[ssh] Relay channel for ${tid} kept dying across ${state.attempts} attempts; giving up. User must reconnect manually.`
      )
      relayLostBackoff.delete(tid)
      // Why: surface the failure — a live SSH connection with a dead relay is otherwise invisible (typing in remote terminals just stops working).
      publishRelayOverride(
        getCurrentMainWindow,
        tid,
        'error',
        'Relay channel kept dropping. Click Reconnect on the SSH target before retrying.',
        0
      )
      return
    }

    const scheduleRelayRedeploy = (delay: number, attemptCharged: boolean): void => {
      state.reconnectTimer = setTimeout(() => {
        state.reconnectTimer = null
        relayLostBackoff.set(tid, state)
        const liveConn = connectionManager?.getConnection(tid)
        if (!liveConn || !activeSessions.has(tid)) {
          clearRelayLostBackoff(tid)
          return
        }
        const status = connectionManager?.getState(tid)?.status
        if (status === 'connected') {
          if (!attemptCharged) {
            // Why: waiting is free, but the deploy it defers is real — charge it here so a transport that
            // flaps back to 'connected' can't redeploy forever on an uncharged budget.
            state.attempts += 1
          }
          void s.reconnect(liveConn, relayGracePeriodForTarget(t))
          return
        }
        if (status === undefined || TRANSPORT_TERMINAL_STATUSES.has(status)) {
          // Why: the transport gave up for good; its own state is what the user acts on, so stop waiting for a redeploy that can never run.
          clearRelayLostBackoff(tid)
          return
        }
        // Why: still mid-transition — re-arm at the max delay without consuming an attempt. It ends once
        // the transport settles: 'connected' redeploys, a terminal status or a dropped session clears above.
        scheduleRelayRedeploy(RELAY_LOST_MAX_DELAY_MS, false)
      }, delay)
      relayLostBackoff.set(tid, state)
    }

    if (!transportConnected) {
      publishRelayOverride(
        getCurrentMainWindow,
        tid,
        'reconnecting',
        'Relay channel lost. Reconnecting...',
        state.attempts
      )
      scheduleRelayRedeploy(RELAY_LOST_MAX_DELAY_MS, false)
      console.warn(
        `[ssh] Relay channel for ${tid} lost while the SSH transport is ${transportStatus ?? 'unknown'}; waiting ${RELAY_LOST_MAX_DELAY_MS}ms without consuming an attempt`
      )
      return
    }

    const delay = Math.min(RELAY_LOST_BASE_DELAY_MS * 2 ** state.attempts, RELAY_LOST_MAX_DELAY_MS)
    state.attempts += 1
    publishRelayOverride(
      getCurrentMainWindow,
      tid,
      'reconnecting',
      'Relay channel lost. Reconnecting...',
      state.attempts
    )
    scheduleRelayRedeploy(delay, true)
    console.warn(
      `[ssh] Relay channel for ${tid} lost; reconnect attempt ${state.attempts}/${RELAY_LOST_MAX_ATTEMPTS} in ${delay}ms`
    )
  })

  // Why: fires after both establish() and reconnect() reach 'ready'; re-create persisted port forwards so they survive restarts and blips.
  session.setOnReady((tid) => {
    notifySshRelayReady(tid)
    const state = relayLostBackoff.get(tid)
    if (state) {
      if (state.stabilizedTimer) {
        clearTimeout(state.stabilizedTimer)
      }
      // Why: stabilization counts post-ready uptime; slow deploy time before `ready` doesn't prove the new relay survived real work.
      state.stabilizedTimer = setTimeout(() => {
        const current = relayLostBackoff.get(tid)
        if (current === state && !current.reconnectTimer) {
          relayLostBackoff.delete(tid)
        }
      }, RELAY_LOST_STABILIZED_MS)
      relayLostBackoff.set(tid, state)
    }
    clearRelayStateOverride(tid)
    if (!testingTargets.has(tid)) {
      broadcastSshState(getCurrentMainWindow, tid, {
        targetId: tid,
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        supportsFolderDownload: connectionSupportsFolderDownload(tid)
      })
    }
    currentRuntime?.notifySshRelayReady?.(tid)
    void restorePortForwards(tid, getCurrentMainWindow)
  })
}

function refreshActiveRelaySessions(): void {
  if (!persistedStore || !portForwardManager) {
    return
  }
  for (const session of activeSessions.values()) {
    session.refreshEnvironment(
      getCurrentMainWindow,
      persistedStore,
      portForwardManager,
      currentRuntime,
      broadcastDetectedPortsFromCurrentWindow
    )
    configureRelaySessionCallbacks(session)
  }
}

export function registerSshHandlers(
  store: Store,
  getMainWindow: () => BrowserWindow | null,
  runtime?: OrcaRuntimeService
): { connectionManager: SshConnectionManager; sshStore: SshConnectionStore } {
  initializeSshConnectionGenerationSession()
  // Why: macOS re-activation re-calls this with a new BrowserWindow; ipcMain.handle() throws on a duplicate channel, so remove prior handlers first.
  for (const ch of SSH_IPC_CHANNELS) {
    ipcMain.removeHandler(ch)
  }

  setCurrentGetMainWindow(getMainWindow)
  setCurrentRuntime(runtime)
  setSshTargetRegistryStore(new SshConnectionStore(store))
  setPersistedStore(store)
  registerAdvertisedUrlRefresh(getCurrentMainWindow)

  registerCredentialHandler(getCurrentMainWindow)

  const callbacks = createSshConnectionCallbacks()
  if (connectionManager) {
    connectionManager.setCallbacks(callbacks)
  } else {
    setConnectionManager(new SshConnectionManager(callbacks))
  }
  setPortForwardManager(portForwardManager ?? new SshPortForwardManager())
  portForwardManager!.setCallbacks({
    onForwardClosed: (entry, reason) => {
      if (reason.kind === 'unexpected-exit') {
        console.warn(
          `[ssh] Port forward ${entry.localPort} → ${entry.remoteHost}:${entry.remotePort} closed unexpectedly${
            reason.detail ? `: ${reason.detail}` : ''
          }`
        )
      }
      persistPortForwardsWithUnrestored(entry.connectionId)
      broadcastPortForwards(getCurrentMainWindow, entry.connectionId)
    }
  })
  refreshActiveRelaySessions()
  registerPowerMonitorReconnect()
  registerSshBrowseHandler(() => connectionManager)
  setSshConnectionManagerResolver(() => connectionManager)

  registerSshTargetCrudHandlers()
  registerSshConnectionHandlers()
  registerSshPortForwardHandlers()

  return {
    connectionManager: connectionManager!,
    sshStore: getSshTargetRegistryStore() as SshConnectionStore
  }
}

export async function resetSshHandlerStateForTests(): Promise<void> {
  unregisterAdvertisedUrlRefresh()
  unregisterPowerMonitorReconnect()
  for (const ch of SSH_IPC_CHANNELS) {
    ipcMain.removeHandler(ch)
  }
  ipcMain.removeHandler('ssh:submitCredential')

  // Why: allSettled — a rejected disposal write must not abort the rest of the reset and leak state into the next test.
  await Promise.allSettled(
    [...activeSessions.values()].map((session) => session.disposeAndPersist())
  )
  activeSessions.clear()
  for (const targetId of relayLostBackoff.keys()) {
    clearRelayLostBackoff(targetId)
  }
  relayStateOverrides.clear()
  connectInFlight.clear()
  targetLifecycleInFlight.clear()
  pendingTransportReconnects.clear()
  resetSshConnectionGenerations()
  resetSshProviderAuthorities()
  resetRelayInFlight.clear()
  testingTargets.clear()
  testConnectionProbes.clear()
  credentialRequestedForTarget.clear()
  quitTeardownStartGate.resetForTests()
  resetSshShutdownDrain()

  await connectionManager?.disconnectAll()
  portForwardManager?.dispose()
  setConnectionManager(null)
  setSshConnectionManagerResolver(null)
  setPortForwardManager(null)
  setSshTargetRegistryStore(null)
  setPersistedStore(null)
  setSshTargetRegistryHandlers({ connect: null, getState: null })
  setCurrentGetMainWindow(() => null)
  setCurrentRuntime(undefined)
}

export function getSshConnectionStore(): SshConnectionStore | null {
  return getSshTargetRegistryStore()
}
