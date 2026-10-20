import { useAppStore } from '@/store'

import { usePipelineCanvasDraftStore } from './pipeline-canvas-draft-store'

const tabCloseWatchers = new Map<string, () => void>()

/** Drops editor draft state only; `pipeline-tab-save` retains explicit in-flight writes. */
export function disposeClosedPipelineTab(fileId: string): void {
  usePipelineCanvasDraftStore.getState().remove(fileId)
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
