import { AlertTriangle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentMapViewportControls } from '@/components/dashboard-popout/AgentMapViewportControls'
import { clamp } from '@/components/dashboard-popout/agent-map-canvas-zoom'
import type { AgentMapViewport } from '@/components/dashboard-popout/agent-map-viewport-transition'
import { useAgentMapCanvasSize } from '@/components/dashboard-popout/useAgentMapCanvasSize'
import { useAgentMapViewportTransition } from '@/components/dashboard-popout/useAgentMapViewportTransition'
import { useNow } from '@/components/dashboard/useNow'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'
import { translate } from '@/i18n/i18n'
import type { PipelineRunSubscriptionError } from '@/runtime/pipeline-run-client'
import type { PipelineRunState } from '../../../../shared/pipeline-run-snapshot'
import { formatPipelineElapsedTime, pipelineNodeElapsedMs } from './pipeline-canvas-elapsed-time'
import PipelineCanvasScene from './PipelineCanvasScene'
import PipelineRunControls from './PipelineRunControls'
import { usePipelineRunSnapshot } from './usePipelineRunSnapshot'

const ELAPSED_TICK_MS = 1000

const MIN_ZOOM = 0.4
const MAX_ZOOM = 3
const FIT_TRANSITION_MS = 220

function runStateLabel(state: PipelineRunState | 'unknown' | null): string {
  switch (state) {
    case 'setup':
      return translate('auto.components.pipeline.canvas.PipelineCanvas.setup', 'Setting up')
    case 'running':
      return translate('auto.components.pipeline.canvas.PipelineCanvas.running', 'Running')
    case 'paused':
      return translate('auto.components.pipeline.canvas.PipelineCanvas.paused', 'Paused')
    case 'completed':
      return translate('auto.components.pipeline.canvas.PipelineCanvas.completed', 'Completed')
    case 'failed':
      return translate('auto.components.pipeline.canvas.PipelineCanvas.failed', 'Failed')
    case 'aborted':
      return translate('auto.components.pipeline.canvas.PipelineCanvas.aborted', 'Aborted')
    case 'interrupted':
      return translate('auto.components.pipeline.canvas.PipelineCanvas.interrupted', 'Interrupted')
    case 'unknown':
    case null:
      return translate('auto.components.pipeline.canvas.PipelineCanvas.unknownState', 'Unknown')
  }
}

function relativeTimeFrom(iso: string | undefined): string {
  if (!iso) {
    return translate('auto.components.pipeline.canvas.PipelineCanvas.recently', 'recently')
  }
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) {
    return translate('auto.components.pipeline.canvas.PipelineCanvas.recently', 'recently')
  }
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (seconds < 60) {
    return translate(
      'auto.components.pipeline.canvas.PipelineCanvas.secondsAgo',
      '{{value0}}s ago',
      {
        value0: seconds
      }
    )
  }
  const minutes = Math.round(seconds / 60)
  return translate('auto.components.pipeline.canvas.PipelineCanvas.minutesAgo', '{{value0}}m ago', {
    value0: minutes
  })
}

function subscriptionErrorHeadline(kind: PipelineRunSubscriptionError['kind']): string {
  return kind === 'unsupported'
    ? translate(
        'auto.components.pipeline.canvas.PipelineCanvas.unsupportedHost',
        'This host does not support pipelines'
      )
    : translate(
        'auto.components.pipeline.canvas.PipelineCanvas.transientSubscriptionError',
        'Could not reach the pipeline run'
      )
}

/**
 * Tab surface for a pipeline run: viewport wiring, run-state header, the
 * "needs a newer Orca" banner, and staleness chrome over the live node scene.
 */
export default function PipelineCanvas({ runId }: { runId: string }): React.JSX.Element {
  const { snapshot, runState, isStale, subscriptionError, target } = usePipelineRunSnapshot(runId)
  const prefersReducedMotion = usePrefersReducedMotion()

  const containerRef = useRef<HTMLDivElement>(null)
  const size = useAgentMapCanvasSize(containerRef, () => {})
  const [viewport, setViewportState] = useState<AgentMapViewport>({
    center: { x: 0, y: 0 },
    zoom: 1
  })
  const viewportRef = useRef(viewport)

  const applyViewport = useCallback((next: AgentMapViewport): void => {
    viewportRef.current = next
    setViewportState(next)
    const container = containerRef.current
    if (container) {
      container.scrollLeft = next.center.x
      container.scrollTop = next.center.y
    }
  }, [])
  const { animate, stop } = useAgentMapViewportTransition({
    durationMs: FIT_TRANSITION_MS,
    reducedMotion: prefersReducedMotion,
    onFrame: applyViewport
  })

  const fit = useCallback((): void => {
    animate(viewportRef.current, { center: { x: 0, y: 0 }, zoom: 1 })
  }, [animate])

  const zoomAtPoint = useCallback(
    (nextZoomRaw: number, clientX?: number, clientY?: number): void => {
      stop()
      const nextZoom = clamp(nextZoomRaw, MIN_ZOOM, MAX_ZOOM)
      const container = containerRef.current
      const current = viewportRef.current
      if (!container || clientX === undefined || clientY === undefined) {
        applyViewport({ center: current.center, zoom: nextZoom })
        return
      }
      const bounds = container.getBoundingClientRect()
      const pointerX = clientX - bounds.left
      const pointerY = clientY - bounds.top
      const ratio = nextZoom / current.zoom
      applyViewport({
        center: {
          x: (current.center.x + pointerX) * ratio - pointerX,
          y: (current.center.y + pointerY) * ratio - pointerY
        },
        zoom: nextZoom
      })
    },
    [applyViewport, stop]
  )

  // why: ctrl/cmd+wheel zooms at the cursor; a plain wheel pans the scroll container natively.
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }
    const handleWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) {
        return
      }
      event.preventDefault()
      zoomAtPoint(
        viewportRef.current.zoom * Math.exp(-event.deltaY * 0.0015),
        event.clientX,
        event.clientY
      )
    }
    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [zoomAtPoint])

  // why: anchors the local tick to when this snapshot was actually received, so the
  // elapsed display never substitutes the renderer's clock for the host's.
  const receivedAtRef = useRef(Date.now())
  const lastSnapshotRef = useRef(snapshot)
  if (lastSnapshotRef.current !== snapshot) {
    lastSnapshotRef.current = snapshot
    receivedAtRef.current = Date.now()
  }
  const now = useNow(ELAPSED_TICK_MS)

  if (!snapshot) {
    if (subscriptionError) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 bg-background text-center">
          <AlertTriangle className="mb-1 size-7 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            {subscriptionErrorHeadline(subscriptionError.kind)}
          </p>
          <p className="max-w-sm text-xs text-muted-foreground">{subscriptionError.message}</p>
        </div>
      )
    }
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 bg-background text-muted-foreground">
        <p className="text-sm font-medium">
          {translate('auto.components.pipeline.canvas.PipelineCanvas.0da3663ff7', 'Pipeline run')}
        </p>
        <p className="font-mono text-xs">{runId}</p>
      </div>
    )
  }

  const nodes = (snapshot.nodes ?? []).map((node) => {
    const elapsedMs = pipelineNodeElapsedMs({
      startedAt: node.startedAt,
      publishedAt: snapshot.publishedAt,
      nowMs: now,
      receivedAtMs: receivedAtRef.current
    })
    return {
      ...node,
      elapsedLabel: elapsedMs === null ? undefined : formatPipelineElapsedTime(elapsedMs)
    }
  })
  const title = snapshot.templateName
    ? `${snapshot.templateName} #${snapshot.runNumber ?? '?'}`
    : runId

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      style={{ width: size.width || undefined }}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium text-foreground">{title}</span>
          <span className="text-xs text-muted-foreground">{runStateLabel(runState)}</span>
          {isStale && (
            <span className="text-xs text-muted-foreground">
              {translate(
                'auto.components.pipeline.canvas.PipelineCanvas.lastConfirmed',
                'last confirmed {{value0}}',
                { value0: relativeTimeFrom(snapshot.publishedAt) }
              )}
            </span>
          )}
        </div>
        <PipelineRunControls runId={runId} runState={runState} target={target} />
      </header>
      {snapshot.needsNewerOrca && (
        <p className="border-b border-border bg-muted px-4 py-1 text-xs text-muted-foreground">
          {translate(
            'auto.components.pipeline.canvas.PipelineCanvas.needsNewerOrca',
            'This template may need a newer Orca'
          )}
        </p>
      )}
      {subscriptionError && (
        <p className="border-b border-border bg-muted px-4 py-1 text-xs text-muted-foreground">
          {subscriptionErrorHeadline(subscriptionError.kind)}
        </p>
      )}
      {runState === 'failed' && snapshot.failureReason && (
        <p className="border-b border-border bg-muted px-4 py-1 text-xs text-destructive">
          {snapshot.failureReason}
        </p>
      )}
      <div ref={containerRef} className="scrollbar-sleek relative min-h-0 flex-1 overflow-auto">
        <div
          style={{ transform: `scale(${viewport.zoom})`, transformOrigin: '0 0' }}
          className="inline-block"
        >
          <PipelineCanvasScene nodes={nodes} pausing={snapshot.pausing === true} />
        </div>
        <AgentMapViewportControls
          zoom={viewport.zoom}
          onFit={fit}
          onZoomIn={() => zoomAtPoint(viewportRef.current.zoom * 1.25)}
          onZoomOut={() => zoomAtPoint(viewportRef.current.zoom / 1.25)}
        />
      </div>
    </div>
  )
}
