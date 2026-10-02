import type { JSX } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export function PipelineExternalChangeBanner({
  onReload,
  onKeepMine
}: {
  onReload: () => void
  onKeepMine: () => void
}): JSX.Element {
  return (
    <div className="pipeline-external-change" role="alert">
      <TriangleAlert
        aria-hidden="true"
        className="size-4 shrink-0 text-status-warning-foreground"
      />
      <p className="min-w-0 flex-1">
        {translate(
          'fork.heimdallPipeline.externalChange.message',
          'This pipeline changed on disk while you were editing.'
        )}
      </p>
      <Button variant="secondary" size="sm" onClick={onReload}>
        {translate('fork.heimdallPipeline.externalChange.reload', 'Reload')}
      </Button>
      <Button variant="outline" size="sm" onClick={onKeepMine}>
        {translate('fork.heimdallPipeline.externalChange.keepMine', 'Keep mine')}
      </Button>
    </div>
  )
}
