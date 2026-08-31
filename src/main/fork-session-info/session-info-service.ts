import type { AgentHookEventPayload } from '../../shared/agent-hook-listener'
import { parseClaudeSessionInfoStatusLineBody } from '../../shared/fork-session-info/claude-statusline-session-info'
import type {
  SessionInfoIdentityTelemetry,
  SessionInfoPaneTelemetry,
  SessionInfoTelemetrySnapshot
} from '../../shared/fork-session-info/session-info-types'
import { readClaudeSessionUsage } from './claude-session-usage-reader'

const MAX_PANE_SNAPSHOTS = 256

type SessionInfoHookEvent = AgentHookEventPayload & {
  receivedAt: number
}

type SessionInfoUpdateListener = (telemetry: SessionInfoPaneTelemetry) => void

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 500)
}

function hasIdentityDetails(identity: SessionInfoIdentityTelemetry): boolean {
  return Object.entries(identity).some(
    ([key, value]) => key !== 'sessionId' && key !== 'updatedAt' && value !== undefined
  )
}

export class SessionInfoService {
  private readonly telemetryByPaneKey = new Map<string, SessionInfoPaneTelemetry>()
  private readonly activeSessionByPaneKey = new Map<string, string>()
  private readonly listeners = new Set<SessionInfoUpdateListener>()
  private readonly scanGenerationByPaneKey = new Map<string, number>()
  private readonly pendingPlanWindowPaneByAccount = new Map<
    string,
    { paneKey: string; receivedAt: number }
  >()

  getSnapshot(): SessionInfoTelemetrySnapshot {
    return Object.fromEntries(this.telemetryByPaneKey)
  }

  subscribe(listener: SessionInfoUpdateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  ingestStatusLineBody(body: unknown, receivedAt = Date.now()): void {
    const event = parseClaudeSessionInfoStatusLineBody(body, receivedAt)
    const telemetry = event?.telemetry
    if (!event || !telemetry?.providerSessionId) {
      return
    }
    const activeSessionId = this.activeSessionByPaneKey.get(telemetry.paneKey)
    if (activeSessionId && activeSessionId !== telemetry.providerSessionId) {
      return
    }
    if (event.fiveHour || event.sevenDay) {
      this.pendingPlanWindowPaneByAccount.set((event.configDir ?? '').trim(), {
        paneKey: telemetry.paneKey,
        receivedAt
      })
    }
    const previous = this.telemetryByPaneKey.get(telemetry.paneKey)
    const sameSession =
      previous?.providerSessionId === telemetry.providerSessionId ? previous : undefined
    const next: SessionInfoPaneTelemetry = {
      ...sameSession,
      ...telemetry,
      ...(sameSession?.identity && telemetry.identity
        ? {
            identity: {
              ...sameSession.identity,
              ...telemetry.identity,
              updatedAt: hasIdentityDetails(telemetry.identity)
                ? telemetry.identity.updatedAt
                : sameSession.identity.updatedAt
            }
          }
        : {})
    }
    this.publish(next)
  }

  confirmPlanWindowsForAccount(configDir: string | null, acceptedAt = Date.now()): void {
    const key = (configDir ?? '').trim()
    const pending = this.pendingPlanWindowPaneByAccount.get(key)
    this.pendingPlanWindowPaneByAccount.delete(key)
    if (!pending || acceptedAt - pending.receivedAt > 5_000) {
      return
    }
    const telemetry = this.telemetryByPaneKey.get(pending.paneKey)
    if (!telemetry) {
      return
    }
    this.publish({ ...telemetry, planWindowsAcceptedAt: acceptedAt })
  }

  observeAgentHook(event: SessionInfoHookEvent): void {
    if (event.source !== 'claude' || !event.providerSession?.id) {
      return
    }
    const paneKey = event.paneKey
    const sessionId = event.providerSession.id
    const previousSessionId = this.activeSessionByPaneKey.get(paneKey)
    this.activeSessionByPaneKey.set(paneKey, sessionId)
    if (previousSessionId !== sessionId) {
      this.scanGenerationByPaneKey.set(
        paneKey,
        (this.scanGenerationByPaneKey.get(paneKey) ?? 0) + 1
      )
      const previous = this.telemetryByPaneKey.get(paneKey)
      if (previous && previous.providerSessionId !== sessionId) {
        this.publish({
          paneKey,
          provider: 'claude',
          providerSessionId: sessionId,
          updatedAt: event.receivedAt
        })
      }
    }
    if (
      event.hookEventName !== 'Stop' ||
      event.payload.sessionBoundary === true ||
      event.connectionId !== null ||
      !event.providerSession.transcriptPath
    ) {
      return
    }
    void this.refreshClaudeUsage(
      paneKey,
      sessionId,
      event.providerSession.transcriptPath,
      event.receivedAt
    )
  }

  clearPane(paneKey: string): void {
    this.activeSessionByPaneKey.delete(paneKey)
    this.telemetryByPaneKey.delete(paneKey)
    this.scanGenerationByPaneKey.set(paneKey, (this.scanGenerationByPaneKey.get(paneKey) ?? 0) + 1)
    const cleared = { paneKey, provider: '', updatedAt: Date.now() }
    this.notify(cleared)
  }

  private async refreshClaudeUsage(
    paneKey: string,
    sessionId: string,
    transcriptPath: string,
    requestedAt: number
  ): Promise<void> {
    const generation = (this.scanGenerationByPaneKey.get(paneKey) ?? 0) + 1
    this.scanGenerationByPaneKey.set(paneKey, generation)
    const previous = this.telemetryByPaneKey.get(paneKey)
    if (previous?.providerSessionId === sessionId && previous.usage) {
      this.publish({ ...previous, usage: { ...previous.usage, freshness: 'refreshing' } })
    }
    try {
      const usage = await readClaudeSessionUsage(transcriptPath, sessionId, requestedAt)
      if (
        this.scanGenerationByPaneKey.get(paneKey) !== generation ||
        this.activeSessionByPaneKey.get(paneKey) !== sessionId
      ) {
        return
      }
      const current = this.telemetryByPaneKey.get(paneKey)
      this.publish({
        ...(current?.providerSessionId === sessionId ? current : {}),
        paneKey,
        provider: 'claude',
        providerSessionId: sessionId,
        usage,
        updatedAt: Math.max(current?.updatedAt ?? 0, requestedAt)
      })
    } catch (error) {
      if (
        this.scanGenerationByPaneKey.get(paneKey) !== generation ||
        this.activeSessionByPaneKey.get(paneKey) !== sessionId
      ) {
        return
      }
      const current = this.telemetryByPaneKey.get(paneKey)
      if (current?.providerSessionId === sessionId && current.usage) {
        this.publish({
          ...current,
          usage: { ...current.usage, freshness: 'stale', error: errorMessage(error) }
        })
      }
    }
  }

  private publish(telemetry: SessionInfoPaneTelemetry): void {
    this.telemetryByPaneKey.delete(telemetry.paneKey)
    this.telemetryByPaneKey.set(telemetry.paneKey, telemetry)
    while (this.telemetryByPaneKey.size > MAX_PANE_SNAPSHOTS) {
      const oldestPaneKey = this.telemetryByPaneKey.keys().next().value as string | undefined
      if (!oldestPaneKey) {
        break
      }
      this.telemetryByPaneKey.delete(oldestPaneKey)
      this.activeSessionByPaneKey.delete(oldestPaneKey)
      this.scanGenerationByPaneKey.delete(oldestPaneKey)
    }
    this.notify(telemetry)
  }

  private notify(telemetry: SessionInfoPaneTelemetry): void {
    for (const listener of this.listeners) {
      try {
        listener(telemetry)
      } catch {
        // one closed renderer must not interrupt agent status delivery
      }
    }
  }
}

export const sessionInfoService = new SessionInfoService()
