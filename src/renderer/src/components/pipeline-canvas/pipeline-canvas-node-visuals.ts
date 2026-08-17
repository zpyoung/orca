import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  HelpCircle,
  Loader2,
  MinusCircle,
  PauseCircle,
  RotateCw,
  XCircle,
  type LucideIcon
} from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { PipelineNodeStatus } from '../../../../shared/pipeline-run-snapshot'

export type PipelineNodeVisual = {
  icon: LucideIcon
  label: string
  toneClassName: string
  spin?: boolean
}

/** One visual per node status tag, including the `unknown` decode fallback. */
export function pipelineNodeVisual(status: PipelineNodeStatus | 'unknown'): PipelineNodeVisual {
  switch (status) {
    case 'succeeded':
      return {
        icon: CheckCircle2,
        label: translate('auto.components.pipeline.canvas.node.visuals.succeeded', 'Succeeded'),
        toneClassName:
          'fill-status-success-background stroke-status-success-border text-status-success'
      }
    case 'failed':
      return {
        icon: XCircle,
        label: translate('auto.components.pipeline.canvas.node.visuals.failed', 'Failed'),
        toneClassName: 'fill-destructive/10 stroke-destructive/40 text-destructive'
      }
    case 'retrying':
      return {
        icon: RotateCw,
        label: translate('auto.components.pipeline.canvas.node.visuals.retrying', 'Retrying'),
        toneClassName: 'fill-destructive/10 stroke-destructive/40 text-destructive'
      }
    case 'running':
      return {
        icon: Loader2,
        label: translate('auto.components.pipeline.canvas.node.visuals.running', 'Running'),
        toneClassName: 'fill-primary/10 stroke-primary text-primary',
        spin: true
      }
    case 'held':
      return {
        icon: PauseCircle,
        label: translate('auto.components.pipeline.canvas.node.visuals.held', 'Held'),
        toneClassName: 'fill-muted stroke-border text-muted-foreground'
      }
    case 'not_run':
      return {
        icon: MinusCircle,
        label: translate('auto.components.pipeline.canvas.node.visuals.notrun', 'Not run'),
        toneClassName: 'fill-muted stroke-border text-muted-foreground'
      }
    case 'interrupted':
      return {
        icon: AlertTriangle,
        label: translate('auto.components.pipeline.canvas.node.visuals.interrupted', 'Interrupted'),
        toneClassName: 'fill-background stroke-foreground/40 text-foreground'
      }
    case 'waiting':
      return {
        icon: CircleDashed,
        label: translate('auto.components.pipeline.canvas.node.visuals.waiting', 'Waiting'),
        toneClassName: 'fill-background stroke-border text-muted-foreground'
      }
    case 'unknown':
      return {
        icon: HelpCircle,
        label: translate('auto.components.pipeline.canvas.node.visuals.unknown', 'Unknown'),
        toneClassName: 'fill-background stroke-border text-muted-foreground [stroke-dasharray:4_3]'
      }
  }
}
