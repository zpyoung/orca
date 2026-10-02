import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { NodeIdSchema } from '../../../shared/fork-heimdall-pipeline/node-id'
import { BUILTIN_PIPELINE_TEXTS } from '../../../shared/fork-heimdall-pipeline/builtin-pipelines'
import { usePipelineCanvasDraftStore } from './pipeline-canvas-draft-store'
import {
  readPersonalPipeline,
  readRepoPipeline,
  statPersonalPipeline,
  watchRepoPipeline,
  type RepoPipelineFiles
} from './pipeline-file-io'
import { disposeClosedPipelineTab } from './pipeline-tab-lifecycle'

function pipelineIdFromRef(scope: 'repo' | 'builtin' | 'user', ref: string): string {
  if (scope === 'repo') {
    return ref
  }
  const separator = ref.indexOf(':')
  return separator === -1 ? ref : ref.slice(separator + 1)
}

function createValidationContext(
  worktreeId: string,
  expectedId: string
): {
  workspaceKind: 'git' | 'folder' | 'unknown'
  expectedId: string
} {
  const state = useAppStore.getState()
  const workspace = parseWorkspaceKey(worktreeId)
  const isKnownWorktree = Boolean(state.getKnownWorktreeById(worktreeId))
  return {
    workspaceKind: workspace?.type === 'folder' ? 'folder' : isKnownWorktree ? 'git' : 'unknown',
    expectedId
  }
}

export function usePipelineCanvasSourceSession(input: {
  file: OpenFile
  id: string
  savedScope: 'repo' | 'builtin' | 'user'
}): { loaded: boolean; loadError: string | null } {
  const { file, id, savedScope } = input
  const pipeline = file.pipeline
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    setLoadError(null)
    if (!usePipelineCanvasDraftStore.getState().drafts[file.id]) {
      setLoaded(false)
    }
    const load = async (): Promise<void> => {
      if (!pipeline) {
        return
      }
      const parsedId = NodeIdSchema.safeParse(id)
      if (!parsedId.success) {
        setLoadError(
          translate('fork.heimdallPipeline.error.invalidId', 'This pipeline id is invalid.')
        )
        setLoaded(true)
        return
      }
      const store = usePipelineCanvasDraftStore.getState()
      const existing = store.drafts[file.id]
      const validationContext = createValidationContext(file.worktreeId, id)
      try {
        if (pipeline.scope === 'builtin') {
          if (!existing) {
            const sourceText = Object.entries(BUILTIN_PIPELINE_TEXTS).find(
              ([builtinId]) => builtinId === id
            )?.[1]
            if (sourceText === undefined) {
              throw new Error(
                translate(
                  'fork.heimdallPipeline.error.builtinMissing',
                  'This built-in pipeline {{id}} is unavailable.',
                  { id }
                )
              )
            }
            store.load(file.id, {
              sourceText,
              layout: null,
              signature: null,
              sourceExists: true,
              expectedId: id,
              validationContext
            })
          }
          setLoaded(true)
          return
        }
        const source: RepoPipelineFiles | null =
          savedScope === 'repo'
            ? await readRepoPipeline({ worktreeId: pipeline.worktreeId, id })
            : await readPersonalPipeline({ id })
        if (disposed) {
          return
        }
        if (existing) {
          if (source) {
            store.diskChanged(file.id, {
              sourceText: source.yamlText,
              layout: source.layout,
              signature: source.signature
            })
          } else if (!existing.isNew || existing.diskSignature) {
            store.diskChanged(file.id, {
              sourceText: '',
              layout: null,
              signature: { mtime: 0, sha256: 'missing' }
            })
          }
        } else {
          store.load(file.id, {
            sourceText: source?.yamlText ?? '',
            layout: source?.layout ?? null,
            signature: source?.signature ?? null,
            sourceExists: source !== null,
            expectedId: id,
            validationContext
          })
        }
        setLoaded(true)
      } catch (error) {
        if (!disposed) {
          setLoadError(error instanceof Error ? error.message : String(error))
          setLoaded(true)
        }
      }
    }
    void load()
    return () => {
      disposed = true
      if (!useAppStore.getState().openFiles.some((openFile) => openFile.id === file.id)) {
        disposeClosedPipelineTab(file.id)
      }
    }
  }, [file.id, file.worktreeId, id, pipeline, savedScope])

  useEffect((): void | (() => void) => {
    if (!pipeline || savedScope !== 'repo') {
      return
    }
    const refresh = (): void => {
      void readRepoPipeline({ worktreeId: pipeline.worktreeId, id })
        .then((source) => {
          const diskState = source ?? {
            yamlText: '',
            layout: null,
            signature: { mtime: 0, sha256: 'missing' }
          }
          usePipelineCanvasDraftStore.getState().diskChanged(file.id, {
            sourceText: diskState.yamlText,
            layout: diskState.layout,
            signature: diskState.signature
          })
        })
        .catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : String(error))
        })
    }
    try {
      return watchRepoPipeline({ worktreeId: pipeline.worktreeId, id }, refresh)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }, [file.id, id, pipeline, savedScope])

  useEffect(() => {
    if (!pipeline || savedScope !== 'user') {
      return
    }
    let disposed = false
    const poll = async (): Promise<void> => {
      if (document.visibilityState === 'hidden') {
        return
      }
      try {
        const latestSignature = await statPersonalPipeline(id)
        const expectedSignature =
          usePipelineCanvasDraftStore.getState().drafts[file.id]?.diskSignature
            ?.personalSignature ?? null
        if (latestSignature === expectedSignature || disposed) {
          return
        }
        const source = latestSignature === null ? null : await readPersonalPipeline({ id })
        if (disposed) {
          return
        }
        usePipelineCanvasDraftStore.getState().diskChanged(file.id, {
          sourceText: source?.yamlText ?? '',
          layout: source?.layout ?? null,
          signature: source?.signature ?? { mtime: 0, sha256: 'missing' }
        })
      } catch (error) {
        if (!disposed) {
          toast.error(error instanceof Error ? error.message : String(error))
        }
      }
    }
    const onVisibilityChange = (): void => {
      void poll()
    }
    const timer = window.setInterval(() => void poll(), 2_000)
    document.addEventListener('visibilitychange', onVisibilityChange)
    void poll()
    return () => {
      disposed = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [file.id, id, pipeline, savedScope])

  return { loaded, loadError }
}

export { pipelineIdFromRef }
