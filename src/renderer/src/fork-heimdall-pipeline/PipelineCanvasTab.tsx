import { lazy, Suspense, type JSX } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { translate } from '@/i18n/i18n'

const LazyPipelineCanvas = lazy(() =>
  import('./PipelineCanvas').then((module) => ({ default: module.PipelineCanvas }))
)

export function PipelineCanvasTab({ file }: { file: OpenFile }): JSX.Element {
  if (!file.pipeline) {
    return (
      <div
        className="flex h-full items-center justify-center text-sm text-muted-foreground"
        role="alert"
      >
        {translate(
          'fork.heimdallPipeline.tab.unavailable',
          'Pipeline tab data is unavailable. Reopen it from Pipelines.'
        )}
      </div>
    )
  }
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          {translate('fork.heimdallPipeline.tab.loading', 'Loading pipeline canvas…')}
        </div>
      }
    >
      <LazyPipelineCanvas file={file} />
    </Suspense>
  )
}
