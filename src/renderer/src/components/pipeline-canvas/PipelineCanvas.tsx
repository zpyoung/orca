import { translate } from '@/i18n/i18n'

/**
 * Tab surface for a pipeline run. The node graph, run controls, and live
 * snapshot wiring ship in a later change — this placeholder exists only so
 * `'pipeline'` tabs have somewhere to render instead of falling through to
 * the editor panel.
 */
export default function PipelineCanvas({ runId }: { runId: string }): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 bg-background text-muted-foreground">
      <p className="text-sm font-medium">
        {translate('auto.components.pipeline.canvas.PipelineCanvas.0da3663ff7', 'Pipeline run')}
      </p>
      <p className="font-mono text-xs">{runId}</p>
    </div>
  )
}
