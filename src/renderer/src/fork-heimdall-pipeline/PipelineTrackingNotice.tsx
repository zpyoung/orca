import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { PipelineTrackingResult } from './pipeline-tab-save'

type PipelineTrackingNoticeProps = {
  result: PipelineTrackingResult | null
  reincludeAvailable: boolean
  onReinclude: () => void
  onDismiss: () => void
}

export function PipelineTrackingNotice({
  result,
  reincludeAvailable,
  onReinclude,
  onDismiss
}: PipelineTrackingNoticeProps): React.JSX.Element | null {
  if (!result || (!result.error && result.response?.status !== 'still-ignored')) {
    return null
  }
  const stillIgnored = result.response?.status === 'still-ignored'
  return (
    <aside
      className="flex flex-wrap items-center justify-between gap-3 border-b border-status-warning-border bg-status-warning-background px-3 py-2 text-xs text-status-warning-foreground"
      role="status"
    >
      <p className="min-w-0 flex-1">
        {result.error
          ? result.error
          : stillIgnored && !reincludeAvailable
            ? (result.response?.detail ??
              translate(
                'fork.heimdallPipeline.tracking.stillIgnored',
                'Git ignores this pipeline. Re-include pipelines to add an explicit exception.'
              ))
            : translate(
                'fork.heimdallPipeline.tracking.personalSuggestion',
                'Git still ignores this pipeline. Save it to My pipelines instead.'
              )}
      </p>
      <div className="flex shrink-0 items-center gap-2">
        {stillIgnored && reincludeAvailable ? null : stillIgnored && !result.error ? (
          <Button type="button" variant="outline" size="xs" onClick={onReinclude}>
            {translate('fork.heimdallPipeline.tracking.reinclude', 'Re-include pipelines')}
          </Button>
        ) : null}
        <Button type="button" variant="ghost" size="xs" onClick={onDismiss}>
          {translate('fork.heimdallPipeline.tracking.dismiss', 'Dismiss')}
        </Button>
      </div>
    </aside>
  )
}
