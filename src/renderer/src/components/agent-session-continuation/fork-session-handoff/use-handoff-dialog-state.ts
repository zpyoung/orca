import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type {
  AgentSessionContinuationContextMode,
  AgentSessionContinuationRequest
} from '@/lib/agent-session-continuation'
import {
  assembleHandoffBriefForSend,
  composeHandoffBrief,
  type HandoffBriefInputs
} from '@/lib/fork-session-handoff/handoff-brief-composer'
import {
  INITIAL_HANDOFF_PREVIEW_PHASE,
  type HandoffPreviewEvent,
  type HandoffPreviewPhase
} from '@/lib/fork-session-handoff/handoff-preview-detach'
import { estimateHandoffTokens } from '@/lib/fork-session-handoff/handoff-token-estimate'
import { saveHandoffTemplate } from '@/lib/fork-session-handoff/handoff-template-mutations'
import { scanHandoffBriefForSecrets } from '@/lib/fork-session-handoff/handoff-secret-scan'
import {
  getHandoffAnchorRepoId,
  listHandoffTargetCandidates,
  resolveHandoffHostChange,
  resolveHandoffTarget
} from '@/lib/fork-session-handoff/handoff-target-resolution'
import { useAppStore } from '@/store'
import {
  DEFAULT_FORK_SESSION_HANDOFF_INCLUDE_TOGGLES,
  type ForkSessionHandoffIncludeToggles
} from '../../../../../shared/fork-session-handoff/handoff-settings-types'
import type { ForkHandoffRelationship } from '../../../../../shared/fork-session-handoff/session-lineage-types'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { buildHandoffDialogOpenSeed } from './handoff-dialog-open-seed'
import { preserveHandoffDraft } from './handoff-draft-preservation'
import type { ForkSessionHandoffRequest } from './prepare-handoff-from-pane'
import type { HandoffDestinationOption } from './HandoffDestinationControls'
import {
  buildHandoffWarnings,
  getHandoffAgentCatalog,
  getHandoffContextDisabledReason,
  getHandoffTemplates,
  handoffInlinedCapture,
  isHandoffContextEmpty,
  isHandoffStartDisabled,
  resolveHandoffDialogSource,
  selectHandoffDialogStoreInputs,
  visibleHandoffCompositionWarnings
} from './handoff-dialog-model'
import {
  captureHandoffSource,
  getHandoffDraftIdentity,
  resolveHandoffSourceActivity,
  selectHandoffSourceStoreInputs
} from './handoff-dialog-source-state'
import { useHandoffDialogStart } from './use-handoff-dialog-start'
import { useHandoffTargetEnvironment } from './use-handoff-target-environment'
import { applyHandoffPreviewEvent } from './handoff-preview-editor-slot'

type UseHandoffDialogStateArgs = {
  open: boolean
  request: AgentSessionContinuationRequest | null
}

export function useHandoffDialogState({ open, request }: UseHandoffDialogStateArgs) {
  const store = useAppStore(useShallow(selectHandoffDialogStoreInputs))
  const sourceStore = useAppStore(useShallow(selectHandoffSourceStoreInputs))
  const openFiles = useAppStore((state) => state.openFiles)
  const forkSource = (request as ForkSessionHandoffRequest | null)?.forkSource
  const anchorWorktreeId = forkSource?.anchorWorktreeId ?? request?.worktreeId ?? ''
  const draftIdentity = useMemo(() => getHandoffDraftIdentity(forkSource), [forkSource])
  const configuredTemplates = store.settings?.forkSessionHandoff?.templates
  // Why: the default catalog is rebuilt per call, so an unmemoized list would give
  // selectedTemplate a new identity every render and defeat the composition memo.
  const templates = useMemo(() => getHandoffTemplates(configuredTemplates), [configuredTemplates])
  const candidates = useMemo(
    () => (anchorWorktreeId ? listHandoffTargetCandidates(store, anchorWorktreeId) : []),
    [anchorWorktreeId, store]
  )
  const targets = useMemo<HandoffDestinationOption[]>(
    () =>
      candidates.map((candidate) => ({
        id: candidate.worktreeId,
        name: candidate.displayName,
        path: candidate.workspacePath
      })),
    [candidates]
  )

  const [targetWorktreeId, setTargetWorktreeId] = useState('')
  const [contextMode, setContextMode] = useState<AgentSessionContinuationContextMode>('focused')
  const [includeToggles, setIncludeToggles] = useState<ForkSessionHandoffIncludeToggles>(
    DEFAULT_FORK_SESSION_HANDOFF_INCLUDE_TOGGLES
  )
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  const [steeringNote, setSteeringNote] = useState('')
  const [relationship, setRelationship] = useState<ForkHandoffRelationship>('continues')
  const [previewPhase, setPreviewPhase] = useState<HandoffPreviewPhase>(
    INITIAL_HANDOFF_PREVIEW_PHASE
  )
  const [previewBody, setPreviewBody] = useState('')
  const [createMode, setCreateMode] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createBaseBranch, setCreateBaseBranch] = useState('')
  const [operationError, setOperationError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [waitRequested, setWaitRequested] = useState(false)
  const [busyDismissed, setBusyDismissed] = useState(false)
  const launchedRef = useRef(false)
  const templateSaveGenerationRef = useRef(0)

  const target = useMemo(
    () => (targetWorktreeId ? resolveHandoffTarget(store, targetWorktreeId) : null),
    [store, targetWorktreeId]
  )
  const sourceTargetWorktreeId = forkSource?.sourceWorktreeId ?? anchorWorktreeId
  const sourceTarget = useMemo(
    () => (sourceTargetWorktreeId ? resolveHandoffTarget(store, sourceTargetWorktreeId) : null),
    [sourceTargetWorktreeId, store]
  )
  const onTranscriptUnavailable = useCallback(() => setContextMode('focused'), [])
  // Why during render: the render sites keep this dialog mounted and toggle `open`, so opening it
  // has to re-seed every field. Doing that in an effect paints the previous session's values for
  // one frame; React re-runs the component before painting when the reset happens here instead.
  const openSession = useMemo(
    () => (open && request ? { draftIdentity, anchorWorktreeId } : null),
    [anchorWorktreeId, draftIdentity, open, request]
  )
  const openSeed = useMemo(
    () =>
      openSession && request
        ? buildHandoffDialogOpenSeed({ draftIdentity, anchorWorktreeId, request })
        : null,
    [anchorWorktreeId, draftIdentity, openSession, request]
  )

  const environment = useHandoffTargetEnvironment({
    open,
    request,
    forkSource,
    targetWorktreeId,
    target,
    sourceTarget,
    includeToggles,
    disabledAgents: store.settings?.disabledTuiAgents,
    lastAgent: store.settings?.forkSessionHandoff?.lastAgent,
    defaultAgent: store.settings?.defaultTuiAgent,
    onTranscriptUnavailable,
    openSession,
    seedAgent: openSeed?.selectedAgent ?? null
  })
  const {
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
  } = environment
  // Why derived: the capture is what ends the wait, so clearing a separate flag would mean an
  // effect resetting the same state its own guard reads.
  const waitingForIdle = waitRequested && capturedText === null
  const sourceActivity = useMemo(
    () => resolveHandoffSourceActivity(forkSource, sourceStore),
    [forkSource, sourceStore]
  )
  const source = useMemo(
    () => resolveHandoffDialogSource(request, capturedText, transcriptResolvedPath),
    [capturedText, request, transcriptResolvedPath]
  )
  const openEditorTabs = useMemo(
    () =>
      includeToggles.openEditorTabs
        ? openFiles
            .filter(
              (file) => file.worktreeId === (forkSource?.sourceWorktreeId ?? anchorWorktreeId)
            )
            .map((file) => file.relativePath)
        : null,
    [anchorWorktreeId, forkSource?.sourceWorktreeId, includeToggles.openEditorTabs, openFiles]
  )
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? null
  useEffect(() => {
    if (selectedTemplateId && !selectedTemplate) {
      setSelectedTemplateId(null)
    }
  }, [selectedTemplate, selectedTemplateId])
  const compositionInputs = useMemo<HandoffBriefInputs | null>(
    () =>
      source
        ? {
            source,
            contextMode,
            transcriptUsableOnTarget: transcriptReachability === 'usable',
            inlinedCapture: handoffInlinedCapture(transcriptReachability, capturedText),
            repoState: includeToggles.repoState ? repoState : null,
            openEditorTabs,
            template: selectedTemplate,
            steeringNote,
            externalContextBlock: null
          }
        : null,
    [
      capturedText,
      contextMode,
      includeToggles.repoState,
      openEditorTabs,
      repoState,
      selectedTemplate,
      source,
      steeringNote,
      transcriptReachability
    ]
  )
  const composition = useMemo(
    () => (compositionInputs ? composeHandoffBrief(compositionInputs) : null),
    [compositionInputs]
  )
  const effectivePreviewBody =
    previewPhase.phase === 'attached' ? (composition?.editableBody ?? '') : previewBody

  useEffect(() => {
    if (!open) {
      templateSaveGenerationRef.current += 1
    }
  }, [open])

  const [seededSession, setSeededSession] = useState<typeof openSession>(null)
  if (openSession !== seededSession) {
    setSeededSession(openSession)
    if (openSeed) {
      setTargetWorktreeId(openSeed.targetWorktreeId)
      setContextMode('focused')
      setIncludeToggles(openSeed.includeToggles)
      setSelectedTemplateId(openSeed.templateId)
      setSteeringNote(openSeed.steeringNote)
      setRelationship('continues')
      setPreviewPhase(openSeed.previewPhase)
      setPreviewBody(openSeed.previewBody)
      setCreateMode(false)
      setCreateName('')
      setCreateBaseBranch('')
      setOperationError(null)
      setWaitRequested(false)
      setBusyDismissed(false)
    }
  }

  useEffect(() => {
    if (openSeed) {
      launchedRef.current = false
    }
  }, [openSeed])

  useEffect(() => {
    if (!waitingForIdle || !sourceActivity.available || sourceActivity.busy) {
      return
    }
    setCapturedText(captureHandoffSource(forkSource, request?.source ?? null))
    applyHandoffPreviewEvent({ type: 'observed-idle' }, setPreviewPhase)
  }, [
    forkSource,
    request?.source,
    setCapturedText,
    sourceActivity.available,
    sourceActivity.busy,
    waitingForIdle
  ])

  const hostChanged = target
    ? resolveHandoffHostChange(forkSource?.sourceExecutionHostId ?? null, target)
    : false
  const secretHits = useMemo(
    () => (hostChanged ? scanHandoffBriefForSecrets(effectivePreviewBody) : []),
    [effectivePreviewBody, hostChanged]
  )
  const sentText = useMemo(
    () => assembleHandoffBriefForSend(effectivePreviewBody),
    [effectivePreviewBody]
  )
  const tokenEstimate = useMemo(() => estimateHandoffTokens(sentText), [sentText])
  const warnings = buildHandoffWarnings({
    sourceBusy: (sourceActivity.busy && !busyDismissed) || waitingForIdle,
    hostChanged,
    secretHits,
    transcriptReachability,
    compositionWarnings: visibleHandoffCompositionWarnings({
      compositionWarnings: composition?.warnings ?? [],
      previewPhase,
      editedBody: previewBody
    }),
    previewPhase,
    operationErrors: [operationError, repoStateError].filter((message): message is string =>
      Boolean(message)
    )
  })
  const agents = getHandoffAgentCatalog(detectedAgents)
  const contextControlDisabled = transcriptReachability !== 'usable'
  const contextDisabledReason = getHandoffContextDisabledReason(transcriptReachability)
  const noContext = isHandoffContextEmpty({
    compositionWarnings: composition?.warnings ?? ['no-context'],
    previewPhase,
    editedBody: previewBody
  })
  const canCreateWorktree = Boolean(
    anchorWorktreeId && getHandoffAnchorRepoId(store, anchorWorktreeId)
  )
  const startDisabled = isHandoffStartDisabled({
    starting,
    detectingAgents,
    selectedAgent,
    target,
    noContext,
    transcriptReachabilityLoading,
    repoStateLoading,
    repoStateIncluded: includeToggles.repoState,
    createMode,
    createName
  })

  const changeControl = useCallback((event: HandoffPreviewEvent = { type: 'controls-changed' }) => {
    applyHandoffPreviewEvent(event, setPreviewPhase)
  }, [])
  const selectTarget = useCallback(
    (worktreeId: string) => {
      setTargetWorktreeId(worktreeId)
      setCreateMode(false)
      setOperationError(null)
      changeControl({ type: 'target-changed' })
    },
    [changeControl]
  )
  const selectAgent = useCallback(
    (agent: TuiAgent | null) => setSelectedAgent(agent),
    [setSelectedAgent]
  )
  const editPreview = useCallback((value: string) => {
    setPreviewBody(value)
    applyHandoffPreviewEvent({ type: 'user-edit' }, setPreviewPhase)
  }, [])
  const regeneratePreview = useCallback(() => {
    setPreviewPhase(INITIAL_HANDOFF_PREVIEW_PHASE)
    setPreviewBody(composition?.editableBody ?? '')
  }, [composition?.editableBody])
  const waitForIdle = useCallback(() => {
    if (sourceActivity.available) {
      setWaitRequested(true)
    }
  }, [sourceActivity.available])
  const captureAnyway = useCallback(() => {
    setWaitRequested(false)
    setBusyDismissed(true)
    setCapturedText(captureHandoffSource(forkSource, request?.source ?? null))
    applyHandoffPreviewEvent({ type: 'observed-idle' }, setPreviewPhase)
  }, [forkSource, request?.source, setCapturedText])

  const saveSteeringNoteAsTemplate = useCallback(
    async (name: string): Promise<boolean> => {
      const generation = ++templateSaveGenerationRef.current
      let template
      try {
        template = await saveHandoffTemplate({
          name,
          body: steeringNote,
          update: (updates) => useAppStore.getState().updateSettingsOrThrow(updates),
          readTemplates: () => useAppStore.getState().settings?.forkSessionHandoff?.templates
        })
      } catch (error) {
        setOperationError(error instanceof Error ? error.message : String(error))
        return false
      }
      if (!template || templateSaveGenerationRef.current !== generation) {
        return false
      }
      // adopting the new template would drop an already-selected one from the brief, so only take
      // over the selection when nothing is selected
      if (!selectedTemplateId) {
        setSelectedTemplateId(template.id)
        setSteeringNote('')
      }
      setOperationError(null)
      changeControl()
      return true
    },
    [changeControl, selectedTemplateId, steeringNote]
  )

  const dismiss = useCallback(() => {
    templateSaveGenerationRef.current += 1
    if (launchedRef.current || !request) {
      return
    }
    preserveHandoffDraft(draftIdentity, {
      steeringNote,
      includeToggles,
      templateId: selectedTemplateId,
      selectedAgent,
      targetWorktreeId,
      preview:
        previewPhase.phase === 'detached'
          ? { phase: 'detached', editedBody: previewBody, staleReasons: previewPhase.staleReasons }
          : { phase: 'attached' }
    })
  }, [
    draftIdentity,
    includeToggles,
    previewBody,
    previewPhase,
    request,
    selectedAgent,
    selectedTemplateId,
    steeringNote,
    targetWorktreeId
  ])

  const launchHandoff = useHandoffDialogStart({
    request,
    forkSource,
    selectedAgent,
    target,
    compositionInputs,
    previewPhase,
    previewBody,
    previewedBody: effectivePreviewBody,
    startDisabled,
    createMode,
    anchorWorktreeId,
    createName,
    createBaseBranch,
    relationship,
    providerSessionId: sourceActivity.providerSessionId,
    draftIdentity,
    includeToggles,
    selectedTemplateId,
    launchedRef,
    setTargetWorktreeId,
    setCreateMode,
    markTargetChanged: () => changeControl({ type: 'target-changed' }),
    setCapturedText,
    setOperationError,
    setStarting
  })
  const start = useCallback(async (): Promise<boolean> => {
    const started = await launchHandoff()
    if (started) {
      templateSaveGenerationRef.current += 1
    }
    return started
  }, [launchHandoff])

  return {
    targets,
    targetWorktreeId,
    targetPath: target?.workspacePath ?? null,
    selectTarget,
    createMode,
    setCreateMode,
    canCreateWorktree,
    createName,
    setCreateName,
    createBaseBranch,
    setCreateBaseBranch,
    relationship,
    setRelationship,
    agents,
    selectedAgent,
    selectAgent,
    detectingAgents,
    agentDetectionFailed,
    contextMode,
    setContextMode: (mode: AgentSessionContinuationContextMode) => {
      setContextMode(mode)
      changeControl()
    },
    contextControlDisabled,
    contextDisabledReason,
    includeToggles,
    setIncludeToggles: (toggles: ForkSessionHandoffIncludeToggles) => {
      setIncludeToggles(toggles)
      changeControl()
    },
    repoStateLoading,
    templates,
    selectedTemplateId,
    setSelectedTemplateId: (templateId: string | null) => {
      setSelectedTemplateId(templateId)
      changeControl()
    },
    steeringNote,
    saveSteeringNoteAsTemplate,
    setSteeringNote: (note: string) => {
      setSteeringNote(note)
      changeControl()
    },
    previewBody: effectivePreviewBody,
    editPreview,
    regeneratePreview,
    previewDetached: previewPhase.phase === 'detached',
    safetyBlock: composition?.safetyBlock ?? '',
    charCount: sentText.length,
    tokenEstimate,
    secretHits,
    warnings,
    waitingForIdle,
    waitForIdle,
    captureAnyway,
    starting,
    startDisabled,
    dismiss,
    start
  }
}
