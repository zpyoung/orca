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
      className="pipeline-validation-list scrollbar-sleek"
      aria-label={translate('fork.heimdallPipeline.validation.title', 'Validation errors')}
    >
      <div className="pipeline-validation-list__heading">
        <AlertTriangle aria-hidden="true" className="size-4 text-destructive" />
        <span>
          {translate('fork.heimdallPipeline.validation.count', '{{value0}} validation errors', {
            value0: errors.length
          })}
        </span>
      </div>
      <ul className="pipeline-validation-list__items">
        {errors.map((error) => {
          const nodeId = error.nodeId
          return (
            <li key={JSON.stringify(error)}>
              {nodeId && onSelectNode ? (
                <Button variant="link" size="xs" onClick={() => onSelectNode(nodeId)}>
                  {nodeId}
                </Button>
              ) : nodeId ? (
                <span className="pipeline-validation-list__node">{nodeId}</span>
              ) : (
                <span className="pipeline-validation-list__node">
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
