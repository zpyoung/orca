import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'

import { usePipelineCanvasDraftStore } from './pipeline-canvas-draft-store'

const tabCloseWatchers = new Map<string, () => void>()

/** Drops editor draft state only; `pipeline-tab-save` retains explicit in-flight writes. */
export function disposeClosedPipelineTab(fileId: string): void {
  usePipelineCanvasDraftStore.getState().remove(fileId)
}

/** Disposes pipeline state and narrows the upstream cache sweep for pipeline mode. */
export function disposePipelineMode(fileId: string, mode: OpenFile['mode']): mode is 'pipeline' {
  if (mode !== 'pipeline') {
    return false
  }
  disposeClosedPipelineTab(fileId)
  return true
}

/** Observe the owner-scoped tab ID, including tabs closed before the canvas mounts. */
export function watchPipelineTabClose(fileId: string): void {
  if (tabCloseWatchers.has(fileId)) {
    return
  }
  let unsubscribe = (): void => {}
  unsubscribe = useAppStore.subscribe((state) => {
    if (state.openFiles.some((file) => file.id === fileId)) {
      return
    }
    unsubscribe()
    tabCloseWatchers.delete(fileId)
    disposeClosedPipelineTab(fileId)
  })
  tabCloseWatchers.set(fileId, unsubscribe)
}
