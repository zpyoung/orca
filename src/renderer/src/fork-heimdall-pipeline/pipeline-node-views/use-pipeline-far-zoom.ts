import { useStore, type ReactFlowState } from '@xyflow/react'

/** Zoom below which cards collapse to their state glyph and label. */
export const PIPELINE_FAR_ZOOM_THRESHOLD = 0.55

const isFarZoom = (state: ReactFlowState): boolean =>
  state.transform[2] < PIPELINE_FAR_ZOOM_THRESHOLD

/** True while the canvas is zoomed out past the threshold; the boolean selector keeps a zoom gesture from re-rendering cards. */
export function usePipelineFarZoom(): boolean {
  return useStore(isFarZoom)
}
