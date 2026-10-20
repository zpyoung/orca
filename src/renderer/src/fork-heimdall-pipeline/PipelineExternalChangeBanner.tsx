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
    <div
      className="flex items-center gap-3 rounded-md border border-status-warning-border bg-status-warning-background px-3 py-2 text-[13px] text-status-warning-foreground"
      role="alert"
    >
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
