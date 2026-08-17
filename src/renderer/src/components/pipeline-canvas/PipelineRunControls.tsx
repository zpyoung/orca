import { useState } from 'react'
import { Pause, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type { PipelineRunState } from '../../../../shared/pipeline-run-snapshot'

export type PipelineRunControlsProps = {
  runId: string
  runState: PipelineRunState | 'unknown' | null
  target: RuntimeClientTarget
}

/** Pause/Resume/Abort for a live pipeline run. Abort requires confirmation. */
export default function PipelineRunControls({
  runId,
  runState,
  target
}: PipelineRunControlsProps): React.JSX.Element | null {
  const [pending, setPending] = useState(false)
  const [abortConfirmOpen, setAbortConfirmOpen] = useState(false)

  if (runState !== 'running' && runState !== 'paused') {
    return null
  }

  const callControl = async (method: 'pipeline.pause' | 'pipeline.resume' | 'pipeline.abort'): Promise<void> => {
    setPending(true)
    try {
      await callRuntimeRpc(target, method, { runId })
    } catch (error) {
      console.warn(`[PipelineRunControls] ${method} failed:`, error)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      {runState === 'running' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => void callControl('pipeline.pause')}
        >
          <Pause className="size-3.5" />
          {translate('auto.components.pipeline.canvas.PipelineRunControls.pause', 'Pause')}
        </Button>
      )}
      {runState === 'paused' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => void callControl('pipeline.resume')}
        >
          <Play className="size-3.5" />
          {translate('auto.components.pipeline.canvas.PipelineRunControls.resume', 'Resume')}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => setAbortConfirmOpen(true)}
      >
        <Square className="size-3.5" />
        {translate('auto.components.pipeline.canvas.PipelineRunControls.abort', 'Abort')}
      </Button>
      <Dialog open={abortConfirmOpen} onOpenChange={setAbortConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {translate(
                'auto.components.pipeline.canvas.PipelineRunControls.abortTitle',
                'Abort this pipeline run?'
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.pipeline.canvas.PipelineRunControls.abortDescription',
                'The running node is interrupted and no further node is dispatched. The worktree and its checkpoints stay in place for you to inspect or recover.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAbortConfirmOpen(false)}>
              {translate('auto.components.pipeline.canvas.PipelineRunControls.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => {
                setAbortConfirmOpen(false)
                void callControl('pipeline.abort')
              }}
            >
              {translate('auto.components.pipeline.canvas.PipelineRunControls.abortRun', 'Abort run')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
