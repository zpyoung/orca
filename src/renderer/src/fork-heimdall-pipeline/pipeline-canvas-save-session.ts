import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { PipelineDocumentSchema } from '../../../shared/fork-heimdall-pipeline/document-schema'
import { validatePipeline } from '../../../shared/fork-heimdall-pipeline/pipeline-validate'
import type { OpenFile } from '@/store/slices/editor'
import { retargetPipelineTabIdentity } from './open-pipeline-tab'
import type { PipelineCanvasDraft } from './pipeline-canvas-draft-store'
import {
  ensurePipelineTracked,
  savePipelineDraft,
  type PipelineTrackingResult
} from './pipeline-tab-save'

export function usePipelineCanvasSaveSession(input: {
  file: OpenFile
  draft: PipelineCanvasDraft | undefined
  readOnly: boolean
}): {
  savedScope: 'repo' | 'builtin' | 'user'
  saving: boolean
  replaceFileDialogOpen: boolean
  onReplaceFileOpenChange: (open: boolean) => void
  saveToChoiceOpen: boolean
  onSaveToChoiceOpenChange: (open: boolean) => void
  unsavedRunDialogOpen: boolean
  setUnsavedRunDialogOpen: (open: boolean) => void
  runSheetOpen: boolean
  runSheetInitialRef: string
  trackingResult: PipelineTrackingResult | null
  trackingReincludeAvailable: boolean
  runDisabled: boolean
  performSave: (
    allowFileRerender?: boolean,
    targetScope?: 'repo' | 'user',
    deferScopeMigration?: boolean
  ) => Promise<string | null>
  requestSave: () => void
  requestRun: () => void
  saveAndRun: () => Promise<void>
  chooseSaveScope: (scope: 'repo' | 'user') => Promise<void>
  reincludePipelines: () => Promise<void>
  handleRunSheetOpenChange: (open: boolean) => void
  trackRepoCopy: (worktreeId: string, pipelineId: string) => Promise<void>
  dismissTracking: () => void
} {
  const { file, draft, readOnly } = input
  const pipeline = file.pipeline
  const [saving, setSaving] = useState(false)
  const [replaceFileDialogOpen, setReplaceFileDialogOpen] = useState(false)
  const [saveToChoiceOpen, setSaveToChoiceOpen] = useState(false)
  const [unsavedRunDialogOpen, setUnsavedRunDialogOpen] = useState(false)
  const [runAfterSave, setRunAfterSave] = useState(false)
  const [pendingTabMigration, setPendingTabMigration] = useState<{
    scope: 'repo' | 'user'
    pipelineId: string
  } | null>(null)
  const [runSheetOpen, setRunSheetOpen] = useState(false)
  const [runSheetInitialRef, setRunSheetInitialRef] = useState(pipeline?.ref ?? '')
  const [trackingResult, setTrackingResult] = useState<PipelineTrackingResult | null>(null)
  const [trackingPipelineId, setTrackingPipelineId] = useState<string | null>(null)
  const [trackingReincludeAvailable, setTrackingReincludeAvailable] = useState(false)
  const [savedScope, setSavedScope] = useState<'repo' | 'builtin' | 'user'>(
    pipeline?.scope ?? 'repo'
  )

  useEffect(() => {
    setSavedScope(pipeline?.scope ?? 'repo')
    setRunSheetInitialRef(pipeline?.ref ?? '')
  }, [file.id, pipeline?.ref, pipeline?.scope])

  const documentValid = (): boolean => {
    if (!draft?.savedDocument) {
      return false
    }
    const parsed = PipelineDocumentSchema.safeParse(draft.savedDocument)
    return (
      parsed.success &&
      validatePipeline(parsed.data, draft.validationContext).length === 0 &&
      draft.validation.length === 0
    )
  }
  const runDisabled = !documentValid() || saving

  const migratePipelineIdentity = useCallback(
    (scope: 'repo' | 'user', pipelineId: string): boolean => {
      if (!pipeline || !retargetPipelineTabIdentity(file.id, scope, pipelineId)) {
        toast.error(
          translate(
            'fork.heimdallPipeline.error.tabIdentityUpdateFailed',
            'The pipeline was saved, but this tab could not be moved to its saved identity. Reopen it from Pipelines.'
          )
        )
        return false
      }
      return true
    },
    [file.id, pipeline]
  )

  const performSave = useCallback(
    async (
      allowFileRerender = false,
      targetScope?: 'repo' | 'user',
      deferScopeMigration = false
    ): Promise<string | null> => {
      if (!pipeline || savedScope === 'builtin' || readOnly || saving) {
        return null
      }
      const saveScope = targetScope ?? savedScope
      setSaving(true)
      try {
        const result = await savePipelineDraft(file.id, {
          allowFileRerender,
          targetScope: saveScope
        })
        if (result.status === 'confirmation-required') {
          setReplaceFileDialogOpen(true)
          return null
        }
        if (result.status === 'disk-changed') {
          setRunAfterSave(false)
          return null
        }
        if (result.status === 'failed') {
          setRunAfterSave(false)
          toast.error(result.message)
          return null
        }
        setReplaceFileDialogOpen(false)
        if (result.tracking) {
          setTrackingResult(result.tracking)
          setTrackingPipelineId(result.pipelineId)
          setTrackingReincludeAvailable(false)
        }
        if (result.fileWasRerendered) {
          toast.warning(
            translate(
              'fork.heimdallPipeline.notice.commentsLost',
              'Some YAML comments could not be preserved.'
            )
          )
        }
        const currentId = pipeline.ref.startsWith('user:')
          ? pipeline.ref.slice('user:'.length)
          : pipeline.ref
        const needsMigration = result.scope !== pipeline.scope || result.pipelineId !== currentId
        if (needsMigration && deferScopeMigration) {
          setPendingTabMigration({ scope: result.scope, pipelineId: result.pipelineId })
        } else {
          setSavedScope(result.scope)
          if (needsMigration) {
            setPendingTabMigration(null)
            migratePipelineIdentity(result.scope, result.pipelineId)
          }
        }
        const ref = result.scope === 'user' ? `user:${result.pipelineId}` : result.pipelineId
        if (allowFileRerender && runAfterSave && !deferScopeMigration) {
          setRunAfterSave(false)
          setRunSheetInitialRef(ref)
          setRunSheetOpen(true)
        }
        return ref
      } catch (error) {
        setRunAfterSave(false)
        toast.error(error instanceof Error ? error.message : String(error))
        return null
      } finally {
        setSaving(false)
      }
    },
    [file.id, migratePipelineIdentity, pipeline, readOnly, runAfterSave, savedScope, saving]
  )

  const requestSave = (): void => {
    if (!draft) {
      return
    }
    if (draft.isNew) {
      setRunAfterSave(false)
      setSaveToChoiceOpen(true)
      return
    }
    void performSave()
  }

  const currentPipelineRef =
    savedScope === 'user'
      ? `user:${pipeline?.ref.startsWith('user:') ? pipeline.ref.slice('user:'.length) : (pipeline?.ref ?? '')}`
      : savedScope === 'builtin'
        ? (pipeline?.ref ?? '')
        : pipeline?.ref.startsWith('user:')
          ? pipeline.ref.slice('user:'.length)
          : (pipeline?.ref ?? '')

  const openRunSheet = (ref: string): void => {
    setRunSheetInitialRef(ref)
    setRunSheetOpen(true)
  }

  const requestRun = (): void => {
    if (runDisabled || !draft) {
      return
    }
    if (draft.dirty) {
      setUnsavedRunDialogOpen(true)
      return
    }
    openRunSheet(currentPipelineRef)
  }

  const saveAndRun = async (): Promise<void> => {
    setUnsavedRunDialogOpen(false)
    if (draft?.isNew) {
      setRunAfterSave(true)
      setSaveToChoiceOpen(true)
      return
    }
    setRunAfterSave(true)
    const ref = await performSave()
    if (ref) {
      setRunAfterSave(false)
      openRunSheet(ref)
    }
  }

  const chooseSaveScope = async (scope: 'repo' | 'user'): Promise<void> => {
    const saveForRun = runAfterSave
    setRunAfterSave(false)
    setSaveToChoiceOpen(false)
    const ref = await performSave(false, scope, saveForRun)
    if (saveForRun && ref) {
      openRunSheet(ref)
    }
  }

  const trackRepoCopy = async (worktreeId: string, pipelineId: string): Promise<void> => {
    const result = await ensurePipelineTracked(worktreeId, pipelineId)
    setTrackingResult(result)
    setTrackingPipelineId(pipelineId)
    setTrackingReincludeAvailable(false)
  }

  const reincludePipelines = async (): Promise<void> => {
    if (!trackingPipelineId || !pipeline) {
      return
    }
    const result = await ensurePipelineTracked(pipeline.worktreeId, trackingPipelineId, true)
    setTrackingResult(result)
    setTrackingReincludeAvailable(true)
  }

  const handleRunSheetOpenChange = (open: boolean): void => {
    setRunSheetOpen(open)
    if (open || !pendingTabMigration) {
      return
    }
    const migration = pendingTabMigration
    setPendingTabMigration(null)
    migratePipelineIdentity(migration.scope, migration.pipelineId)
  }
  const onSaveToChoiceOpenChange = useCallback((open: boolean): void => {
    setSaveToChoiceOpen(open)
    if (!open) {
      setRunAfterSave(false)
    }
  }, [])
  const onReplaceFileOpenChange = useCallback((open: boolean): void => {
    setReplaceFileDialogOpen(open)
    if (!open) {
      setRunAfterSave(false)
    }
  }, [])

  return {
    savedScope,
    saving,
    replaceFileDialogOpen,
    onReplaceFileOpenChange,
    saveToChoiceOpen,
    onSaveToChoiceOpenChange,
    unsavedRunDialogOpen,
    setUnsavedRunDialogOpen,
    runSheetOpen,
    runSheetInitialRef,
    trackingResult,
    trackingReincludeAvailable,
    runDisabled,
    performSave,
    requestSave,
    requestRun,
    saveAndRun,
    chooseSaveScope,
    reincludePipelines,
    handleRunSheetOpenChange,
    trackRepoCopy,
    dismissTracking: () => setTrackingResult(null)
  }
}
