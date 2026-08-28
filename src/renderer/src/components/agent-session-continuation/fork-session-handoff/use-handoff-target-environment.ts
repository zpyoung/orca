import { useCallback, useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import { fetchHandoffRepoState } from '@/lib/fork-session-handoff/handoff-repo-state'
import {
  createHandoffAgentDetectionGeneration,
  type HandoffTargetResolution
} from '@/lib/fork-session-handoff/handoff-target-resolution'
import {
  resolveTranscriptReachability,
  type HandoffTranscriptProbeOutcome,
  type HandoffTranscriptReachability
} from '@/lib/fork-session-handoff/handoff-transcript-reachability'
import { useAppStore } from '@/store'
import type { ForkSessionHandoffIncludeToggles } from '../../../../../shared/fork-session-handoff/handoff-settings-types'
import { isTuiAgentEnabled } from '../../../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { chooseHandoffAgent } from './handoff-dialog-model'
import { captureHandoffSource } from './handoff-dialog-source-state'
import type { ForkSessionHandoffSource } from './prepare-handoff-from-pane'

function getHandoffTargetKey(target: HandoffTargetResolution | null): string | null {
  return target
    ? JSON.stringify([
        target.worktreeId,
        target.workspacePath,
        target.sshConnectionId,
        target.runtimeEnvironmentId,
        target.isFolderWorkspace
      ])
    : null
}

function getTranscriptProbeKey(args: {
  open: boolean
  request: AgentSessionContinuationRequest | null
  forkSource: ForkSessionHandoffSource | undefined
  target: HandoffTargetResolution | null
}): string | null {
  if (!args.open || !args.request || !args.target) {
    return null
  }
  return JSON.stringify([
    args.request.source.transcriptPath?.trim() ?? '',
    resolveProbeAgent(args.request, args.forkSource),
    resolveProbeSessionId(args.forkSource),
    args.forkSource?.sourcePaneKey ?? null,
    args.request.source.sourceWorkingDirectory ?? null,
    args.forkSource?.sourceExecutionHostId ?? null,
    args.target.worktreeId,
    args.target.sshConnectionId,
    args.target.runtimeEnvironmentId
  ])
}

function resolveProbeAgent(
  request: AgentSessionContinuationRequest,
  forkSource: ForkSessionHandoffSource | undefined
): string | null {
  return forkSource?.vaultAgent ?? request.source.sourceAgent ?? null
}

function resolveProbeSessionId(forkSource: ForkSessionHandoffSource | undefined): string | null {
  return forkSource?.providerSessionId ?? forkSource?.vaultSessionId ?? null
}

export function useHandoffTargetEnvironment(args: {
  open: boolean
  request: AgentSessionContinuationRequest | null
  forkSource: ForkSessionHandoffSource | undefined
  targetWorktreeId: string
  target: HandoffTargetResolution | null
  sourceTarget: HandoffTargetResolution | null
  includeToggles: ForkSessionHandoffIncludeToggles
  disabledAgents: TuiAgent[] | undefined
  lastAgent: TuiAgent | undefined
  defaultAgent: unknown
  onTranscriptUnavailable: () => void
  openSession: object | null
  seedAgent: TuiAgent | null
}) {
  const {
    open,
    request,
    forkSource,
    targetWorktreeId,
    target,
    sourceTarget,
    includeToggles,
    disabledAgents,
    lastAgent,
    defaultAgent,
    onTranscriptUnavailable,
    openSession,
    seedAgent
  } = args
  const [selectedAgent, setSelectedAgentState] = useState<TuiAgent | null>(null)
  const selectedAgentRef = useRef<TuiAgent | null>(null)
  const [detectedAgents, setDetectedAgents] = useState<TuiAgent[]>([])
  const [detectingAgents, setDetectingAgents] = useState(true)
  const [agentDetectionFailed, setAgentDetectionFailed] = useState(false)
  const transcriptProbeKey = getTranscriptProbeKey({ open, request, forkSource, target })
  const [transcriptProbe, setTranscriptProbe] = useState<
    HandoffTranscriptProbeOutcome & { key: string | null }
  >({ key: null, verdict: 'none', transcriptPath: null })
  const transcriptReachabilityLoading = Boolean(
    transcriptProbeKey && transcriptProbe.key !== transcriptProbeKey
  )
  const transcriptMatchesProbe = transcriptProbe.key === transcriptProbeKey
  const transcriptReachability: HandoffTranscriptReachability = transcriptMatchesProbe
    ? transcriptProbe.verdict
    : 'none'
  const transcriptResolvedPath = transcriptMatchesProbe ? transcriptProbe.transcriptPath : null
  const [capturedText, setCapturedText] = useState<string | null>(null)
  const [repoState, setRepoState] =
    useState<Awaited<ReturnType<typeof fetchHandoffRepoState>>>(null)
  const [repoStateLoading, setRepoStateLoading] = useState(false)
  const [repoStateError, setRepoStateError] = useState<string | null>(null)
  const detectorRef = useRef(createHandoffAgentDetectionGeneration())
  const detectionRequestRef = useRef(0)
  // Why: resolveHandoffTarget rebuilds its result on every unrelated store write, so effects
  // key on the resolved identity and read the object through a ref instead of re-running.
  const targetRef = useRef(target)
  targetRef.current = target
  const sourceTargetRef = useRef(sourceTarget)
  sourceTargetRef.current = sourceTarget
  const sourceTargetKey = getHandoffTargetKey(sourceTarget)
  const requestRef = useRef(request)
  requestRef.current = request
  const forkSourceRef = useRef(forkSource)
  forkSourceRef.current = forkSource
  const disabledAgentsRef = useRef(disabledAgents)
  disabledAgentsRef.current = disabledAgents
  const disabledAgentsKey = (disabledAgents ?? []).join(',')

  const setSelectedAgent = useCallback((agent: TuiAgent | null) => {
    selectedAgentRef.current = agent
    setSelectedAgentState(agent)
  }, [])

  // Why during render: a reopened dialog must start from the seed, and doing it in an effect paints
  // the previous session's agent and capture for one frame.
  const [seededSession, setSeededSession] = useState<object | null>(null)
  if (openSession !== seededSession) {
    setSeededSession(openSession)
    if (openSession) {
      setSelectedAgent(seedAgent)
      setCapturedText(null)
    }
  }

  useEffect(() => {
    if (!open || !targetWorktreeId) {
      return
    }
    const detector = detectorRef.current
    const requestId = ++detectionRequestRef.current
    setDetectingAgents(true)
    setAgentDetectionFailed(false)
    void detector
      .detect(targetWorktreeId, selectedAgentRef.current)
      .then((result) => {
        if (!result || requestId !== detectionRequestRef.current) {
          return
        }
        const enabled = result.agents.filter((agent) =>
          isTuiAgentEnabled(agent, disabledAgentsRef.current)
        )
        setDetectedAgents(enabled)
        setSelectedAgent(
          chooseHandoffAgent(
            enabled,
            selectedAgentRef.current,
            result.selectedAgent,
            lastAgent,
            request?.source.sourceAgent,
            defaultAgent
          )
        )
      })
      .catch(() => {
        if (requestId !== detectionRequestRef.current) {
          return
        }
        setDetectedAgents([])
        setSelectedAgent(null)
        setAgentDetectionFailed(true)
      })
      .finally(() => {
        if (requestId === detectionRequestRef.current) {
          setDetectingAgents(false)
        }
      })
    return () => {
      detector.invalidate()
      if (requestId === detectionRequestRef.current) {
        detectionRequestRef.current += 1
      }
    }
  }, [
    defaultAgent,
    disabledAgentsKey,
    lastAgent,
    open,
    request?.source.sourceAgent,
    targetWorktreeId,
    setSelectedAgent
  ])

  useEffect(() => {
    const probedRequest = requestRef.current
    const probedTarget = targetRef.current
    if (!probedRequest || !probedTarget || !transcriptProbeKey) {
      setTranscriptProbe({ key: null, verdict: 'none', transcriptPath: null })
      return
    }
    const probedForkSource = forkSourceRef.current
    let current = true
    void resolveTranscriptReachability({
      agent: resolveProbeAgent(probedRequest, probedForkSource),
      sessionId: resolveProbeSessionId(probedForkSource),
      transcriptPath: probedRequest.source.transcriptPath ?? null,
      paneKey: probedForkSource?.sourcePaneKey ?? null,
      workspacePath: probedRequest.source.sourceWorkingDirectory ?? null,
      sourceExecutionHostId: probedForkSource?.sourceExecutionHostId ?? null,
      target: probedTarget
    }).then((outcome) => {
      if (!current) {
        return
      }
      setTranscriptProbe({ key: transcriptProbeKey, ...outcome })
      if (outcome.verdict !== 'usable') {
        onTranscriptUnavailable()
      }
      // An unverified transcript is as unusable as an absent one, so both fall
      // back to the bounded capture.
      if (outcome.verdict === 'unreachable' || outcome.verdict === 'unverifiable') {
        setCapturedText(captureHandoffSource(probedForkSource, probedRequest.source))
      }
    })
    return () => {
      current = false
    }
  }, [onTranscriptUnavailable, setCapturedText, transcriptProbeKey])

  useEffect(() => {
    const fetchTarget = sourceTargetRef.current
    if (!open || !fetchTarget || fetchTarget.isFolderWorkspace || !includeToggles.repoState) {
      setRepoState(null)
      setRepoStateError(null)
      setRepoStateLoading(false)
      return
    }
    const controller = new AbortController()
    setRepoStateLoading(true)
    setRepoStateError(null)
    void fetchHandoffRepoState({
      state: useAppStore.getState(),
      target: fetchTarget,
      includeDiffBodies: includeToggles.diffBodies,
      signal: controller.signal
    })
      .then(setRepoState)
      .catch((error) => {
        if (error instanceof Error && error.name === 'AbortError') {
          return
        }
        setRepoState(null)
        setRepoStateError(
          translate(
            'components.agentSessionContinuation.forkSessionHandoff.repoStateFailed',
            'Could not refresh repository state. The handoff can still continue.'
          )
        )
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setRepoStateLoading(false)
        }
      })
    return () => controller.abort()
  }, [includeToggles.diffBodies, includeToggles.repoState, open, sourceTargetKey])

  return {
    selectedAgent,
    setSelectedAgent,
    detectedAgents,
    detectingAgents,
    agentDetectionFailed,
    transcriptReachability,
    transcriptReachabilityLoading,
    transcriptResolvedPath,
    capturedText,
    setCapturedText,
    repoState,
    repoStateLoading,
    repoStateError
  }
}
