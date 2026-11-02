import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session/options/agent-session-option-catalog'
import { matchNativeChatCatalogModelId } from '../../../../shared/native-chat/input/native-chat-session-option-state'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat/input/native-chat-session-options'
import type { NativeChatSessionOptionObservation } from '../../../../shared/native-chat-types'
import { nativeChatReportedValuesFromObservation } from './fork-native-chat-session-options/native-chat-session-option-observation'
import {
  hasDispatchedNativeChatSessionOption,
  useClaudeStartupFrameRevision
} from './fork-native-chat-session-options/use-claude-startup-frame-revision'
import { useAppStore } from '../../store'
import { sayNativeChatSessionOptionTranslated } from './native-chat-session-option-labels-text'
import {
  createNativeChatPtySessionOptions,
  type NativeChatPtySessionOptionsSurface
} from '../../../../shared/native-chat-pty-session-options'
import type { NativeChatSessionOptionDispatchCommand } from '../../../../shared/native-chat-session-option-dispatch'
import {
  ensureNativeChatModelEnrichment,
  readNativeChatEnrichedModels,
  subscribeNativeChatEnrichedModels
} from './native-chat-session-option-enrichment'
import {
  discoverNativeChatCatalogModels,
  resolveNativeChatModelDiscoveryContext
} from './native-chat-session-option-discovery'
import { readClaudeSessionOptionsFromTerminalScreen } from './claude-terminal-session-options'
import { retireAutomationLaunchModelsMissingFromDiscovery } from './fork-automation-launch-settings/retire-automation-launch-models'

import { enqueueSessionOptionSettingsWrite } from './native-chat-session-option-settings-write'

const EMPTY_SNAPSHOT: SessionOptionDescriptor[] = []
const subscribeEmpty = (): (() => void) => () => {}
const getEmptySnapshot = (): SessionOptionDescriptor[] => EMPTY_SNAPSHOT

const CLIENT_SETTINGS_TARGET = { kind: 'local' } as const

export function useNativeChatSessionOptions(args: {
  agent: AgentType
  terminalTabId: string
  targetPtyId: string | null
  dispatchCommand: NativeChatSessionOptionDispatchCommand
  onAgentPicker?: () => void
  readTerminalScreen?: () => string | null
  /** What the agent recorded about itself in its own session log. Authoritative
   *  over the screen scrape: it is written per turn, so it outlives the scrollback
   *  and reflects a switch made outside the composer. */
  reportedSessionOptions?: NativeChatSessionOptionObservation | null
  /** OMP model evidence comes from its hook; Claude uses its terminal frame. */
  paneKey?: string
}): {
  surface: NativeChatPtySessionOptionsSurface | null
  snapshot: SessionOptionDescriptor[]
} {
  const {
    agent,
    terminalTabId,
    targetPtyId,
    dispatchCommand,
    onAgentPicker,
    readTerminalScreen,
    reportedSessionOptions,
    paneKey
  } = args
  const reportedModel = useAppStore((state) =>
    paneKey ? (state.agentStatusByPaneKey[paneKey]?.model ?? null) : null
  )
  const canSwitchOmpModel = useAppStore((state) =>
    paneKey ? state.agentStatusByPaneKey[paneKey]?.modelSwitchCommand === 'orca-model' : false
  )
  // Only changed hook models are new evidence; repeated status pings must not undo newer user picks.
  const appliedReportedModelRef = useRef<string | null>(null)
  // Cache parsed screen text so late discovery can resolve real host model IDs.
  const reportedScreenRef = useRef<string | null>(null)
  // The observation this pty's session log last supplied. Set at all means the log
  // has answered, which retires the screen scrape; the value itself lets a later
  // model discovery re-resolve it against the host's real ids.
  const observedFromLogRef = useRef<NativeChatSessionOptionObservation | null>(null)
  const observedPtyRef = useRef<string | null>(targetPtyId)
  if (observedPtyRef.current !== targetPtyId) {
    // A new pty is a new session; nothing the old one logged describes it.
    observedPtyRef.current = targetPtyId
    observedFromLogRef.current = null
    reportedScreenRef.current = null
  }
  const discoveryContext = useMemo(
    () => resolveNativeChatModelDiscoveryContext(terminalTabId),
    [terminalTabId]
  )
  const surface = useMemo(() => {
    // Chat attaches after startup is queued, so a draft picker could no longer change its command.
    if (!targetPtyId) {
      return null
    }
    const scopeKey = targetPtyId ?? terminalTabId
    const discoveredModels = discoveryContext
      ? readNativeChatEnrichedModels(agent, discoveryContext.hostKey)
      : null
    const reportedValues =
      agent === 'claude'
        ? readClaudeSessionOptionsFromTerminalScreen(
            readTerminalScreen?.(),
            discoveredModels ?? undefined
          )
        : null
    return createNativeChatPtySessionOptions({
      agent,
      scopeKey,
      ...(targetPtyId ? { fallbackScopeKey: terminalTabId } : {}),
      // Version-neutral family seeds keep the picker available while host discovery runs or fails.
      ...(discoveryContext ? { initialModels: discoveredModels ?? undefined } : {}),
      mode: targetPtyId ? 'live' : 'draft',
      modelLabel: sayNativeChatSessionOptionTranslated('model'),
      reportedValues,
      dispatchCommand,
      canSwitchOmpModel,
      onAgentPicker,
      persistSelection: ({ modelId, optionId, value, adoptModelAsLaunchDefault }) =>
        // Paired PTY launches still assemble their launch preferences from client settings.
        enqueueSessionOptionSettingsWrite(CLIENT_SETTINGS_TARGET, {
          type: 'apply-picks',
          agent,
          picks: [{ modelId, optionId, value, adoptModelAsLaunchDefault }]
        })
    })
  }, [
    agent,
    canSwitchOmpModel,
    dispatchCommand,
    discoveryContext,
    onAgentPicker,
    readTerminalScreen,
    targetPtyId,
    terminalTabId
  ])
  const startupFrameRevision = useClaudeStartupFrameRevision({
    agent,
    terminalTabId,
    targetPtyId,
    surface
  })

  useEffect(() => {
    if (!surface || !discoveryContext || !reportedSessionOptions) {
      return
    }
    const values = nativeChatReportedValuesFromObservation({
      observation: reportedSessionOptions,
      agent,
      models: readNativeChatEnrichedModels(agent, discoveryContext.hostKey) ?? []
    })
    if (values) {
      observedFromLogRef.current = reportedSessionOptions
      surface.reportSessionOptions(values, reportedSessionOptions.observedAt)
    }
  }, [agent, discoveryContext, reportedSessionOptions, surface])

  useEffect(() => {
    // Why: the log is per-turn evidence and the frame is not, so once the log has
    // answered for this pty, re-reading a frame painted before it can only rewind.
    if (!surface || agent !== 'claude' || observedFromLogRef.current) {
      return
    }
    let cancelled = false
    const reportCurrentValues = async (): Promise<void> => {
      let authoritativeScreen: string | null = null
      if (targetPtyId && window.api?.pty?.getMainBufferSnapshot) {
        try {
          const snapshot = await window.api.pty.getMainBufferSnapshot(targetPtyId, {
            scrollbackRows: 0
          })
          // Main-buffer snapshots are stale during alternate-screen TUIs; use mounted xterm then.
          authoritativeScreen = snapshot?.alternateScreen ? null : (snapshot?.data ?? null)
        } catch {
          // The mounted renderer buffer remains a transport-neutral fallback.
        }
      }
      const models = discoveryContext
        ? readNativeChatEnrichedModels(agent, discoveryContext.hostKey)
        : null
      for (const screen of [authoritativeScreen, readTerminalScreen?.() ?? null]) {
        const reportedValues = readClaudeSessionOptionsFromTerminalScreen(
          screen,
          models ?? undefined
        )
        if (!reportedValues) {
          continue
        }
        // Retain parsed screen text for late discovery after the model frame scrolls away.
        if (
          cancelled ||
          observedFromLogRef.current ||
          hasDispatchedNativeChatSessionOption(surface)
        ) {
          return
        }
        reportedScreenRef.current = screen
        surface.reportSessionOptions(reportedValues)
        return
      }
    }
    void reportCurrentValues()
    return () => {
      cancelled = true
    }
  }, [agent, discoveryContext, readTerminalScreen, startupFrameRevision, surface, targetPtyId])

  // Scope survives surface rebuilds; reapplying an unchanged report would revert the user’s pick.
  useEffect(() => {
    appliedReportedModelRef.current = null
  }, [agent, targetPtyId, terminalTabId])

  useEffect(() => {
    // Claude uses terminal-frame evidence; other agents report model IDs in status hooks.
    if (!surface || agent === 'claude' || !reportedModel) {
      return
    }
    const catalog = getAgentSessionOptionCatalog(agent)
    if (!catalog) {
      return
    }
    const models =
      (discoveryContext ? readNativeChatEnrichedModels(agent, discoveryContext.hostKey) : null) ??
      catalog.models
    // OMP reports exact selectors, including models absent from cached discovery.
    const matched =
      agent === 'omp'
        ? reportedModel.trim()
        : matchNativeChatCatalogModelId({ ...catalog, models }, reportedModel, {
            allowUnlisted: agent === 'codex'
          })
    if (!matched || appliedReportedModelRef.current === matched) {
      return
    }
    appliedReportedModelRef.current = matched
    surface.reportSessionOptions({ model: matched })
  }, [agent, discoveryContext, reportedModel, surface])

  useEffect(() => {
    if (!surface || !discoveryContext) {
      return
    }
    const unsubscribe = subscribeNativeChatEnrichedModels(
      agent,
      discoveryContext.hostKey,
      (models) => {
        surface.replaceModels(models)
        const observation = observedFromLogRef.current
        const screen = agent === 'claude' ? reportedScreenRef.current : null
        // Why: both readings resolved against the seed families before the probe
        // landed. Re-resolving now is what upgrades `opus` to the host's real
        // `opus[1m]` — the frame itself may already have scrolled out of reach.
        if (observation) {
          const values = nativeChatReportedValuesFromObservation({ observation, agent, models })
          if (values) {
            surface.reportSessionOptions(values, observation.observedAt)
          }
        } else if (screen) {
          const reportedValues = readClaudeSessionOptionsFromTerminalScreen(screen, models)
          if (reportedValues) {
            surface.reportSessionOptions(reportedValues)
          }
        }
        void retireAutomationLaunchModelsMissingFromDiscovery(
          agent,
          discoveryContext.hostKey,
          models
        ).catch(() => undefined)
      }
    )
    // Subscriptions do not replay; inspect cached discovery so pre-mount probes can retire stale automation models.
    const cached = readNativeChatEnrichedModels(agent, discoveryContext.hostKey)
    if (cached) {
      void retireAutomationLaunchModelsMissingFromDiscovery(
        agent,
        discoveryContext.hostKey,
        cached
      ).catch(() => undefined)
    }
    ensureNativeChatModelEnrichment({
      agent,
      hostKey: discoveryContext.hostKey,
      discover: () =>
        discoverNativeChatCatalogModels(agent, discoveryContext.runtime, discoveryContext.hostKey)
    })
    return unsubscribe
  }, [agent, discoveryContext, surface])

  const snapshot = useSyncExternalStore(
    surface?.subscribe ?? subscribeEmpty,
    surface?.getSnapshot ?? getEmptySnapshot,
    surface?.getSnapshot ?? getEmptySnapshot
  )
  return { surface, snapshot }
}
