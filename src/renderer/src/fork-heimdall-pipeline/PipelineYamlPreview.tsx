import type { JSX } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'

export function PipelineYamlPreview({ text }: { text: string }): JSX.Element {
  return (
    <section
      className="flex min-h-0 flex-1 p-3"
      aria-label={translate('fork.heimdallPipeline.preview.title', 'YAML preview')}
    >
      <Textarea
        aria-label={translate('fork.heimdallPipeline.preview.yaml', 'Read-only pipeline YAML')}
        className="h-full min-h-0 resize-none"
        value={text}
        readOnly
        spellCheck={false}
      />
    </section>
  )
}
