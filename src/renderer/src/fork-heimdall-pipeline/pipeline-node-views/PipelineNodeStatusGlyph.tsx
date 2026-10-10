import type { JSX } from 'react'
import { Check, CircleHelp } from 'lucide-react'
import { AgentWorkingSpinner } from '@/components/AgentWorkingSpinner'
import type { PipelineNodeVisualState } from '../pipeline-run-visual-state'

function GlyphShape({ state }: { state: PipelineNodeVisualState }): JSX.Element {
  switch (state) {
    case 'running':
      return <AgentWorkingSpinner className="size-full" />
    case 'failed':
      return <span className="block size-[70%] rotate-45 rounded-xs bg-destructive" />
    case 'needs-you':
      return (
        <span className="block size-full rounded-full border-2 border-dotted border-status-warning" />
      )
    case 'waiting':
      return (
        <span className="block size-full rounded-full border-2 border-dashed border-status-warning" />
      )
    case 'pending':
      return <span className="block size-full rounded-full border-2 border-muted-foreground" />
    case 'done':
      return <Check aria-hidden="true" className="size-full text-status-success" />
    case 'skipped':
      return (
        <span className="block size-full rounded-full border-2 border-dashed border-muted-foreground opacity-50" />
      )
    case 'unknown':
      return <CircleHelp aria-hidden="true" className="size-full text-muted-foreground" />
  }
}

/** The one shape that marks a node's visual state; decorative, since the status label and card text carry the meaning. */
export function PipelineNodeStatusGlyph({
  state
}: {
  state: PipelineNodeVisualState
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-glyph={state}
      className="pipeline-node-glyph inline-flex size-3.5 shrink-0 items-center justify-center"
    >
      <GlyphShape state={state} />
    </span>
  )
}
