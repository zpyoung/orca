import type { JSX } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { PipelineValidationError } from '../../../shared/fork-heimdall-pipeline/pipeline-validate'

export function PipelineValidationList({
  errors,
  onSelectNode
}: {
  errors: readonly PipelineValidationError[]
  onSelectNode?: (nodeId: string) => void
}): JSX.Element | null {
  if (errors.length === 0) {
    return null
  }
  return (
    <section
      className="scrollbar-sleek max-h-36 overflow-auto rounded-md border border-destructive bg-destructive px-3 py-2 text-destructive-foreground"
      aria-label={translate('fork.heimdallPipeline.validation.title', 'Validation errors')}
    >
      <div className="flex items-center gap-1.5 text-xs font-semibold">
        <AlertTriangle aria-hidden="true" className="size-4 text-destructive" />
        <span>
          {translate('fork.heimdallPipeline.validation.count', '{{value0}} validation errors', {
            value0: errors.length
          })}
        </span>
      </div>
      <ul className="mt-1.5 grid gap-1 text-xs">
        {errors.map((error) => {
          const nodeId = error.nodeId
          return (
            <li key={JSON.stringify(error)} className="flex items-baseline gap-2">
              {nodeId && onSelectNode ? (
                <Button variant="link" size="xs" onClick={() => onSelectNode(nodeId)}>
                  {nodeId}
                </Button>
              ) : nodeId ? (
                <span className="flex-none font-mono text-xs">{nodeId}</span>
              ) : (
                <span className="flex-none font-mono text-xs">
                  {translate('fork.heimdallPipeline.validation.pipeline', 'Pipeline')}
                </span>
              )}
              <span>{error.message}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
