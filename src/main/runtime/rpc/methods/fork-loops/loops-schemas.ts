import { z } from 'zod'
import {
  LoopCreateInputSchema,
  LoopEditPatchSchema,
  QueueOpSchema
} from '../../../../../shared/fork-loops/loop-types'

const LoopIdSchema = z.string().min(1)

export const LoopCreateParamsSchema = LoopCreateInputSchema

export const LoopListParamsSchema = z.object({ worktreeId: z.string().min(1).optional() }).strict()

export const LoopTargetParamsSchema = z.object({ loopId: LoopIdSchema }).strict()

export const LoopPauseParamsSchema = z
  .object({ loopId: LoopIdSchema, mode: z.literal('after-iteration') })
  .strict()

export const LoopResumeParamsSchema = z
  .object({ loopId: LoopIdSchema, addIterations: z.number().int().min(1).optional() })
  .strict()

export const LoopStopParamsSchema = z
  .object({ loopId: LoopIdSchema, mode: z.enum(['after-iteration', 'now']) })
  .strict()

export const LoopSteerParamsSchema = z
  .object({ loopId: LoopIdSchema, text: z.string().min(1) })
  .strict()

export const LoopEditParamsSchema = z
  .object({ loopId: LoopIdSchema, patch: LoopEditPatchSchema })
  .strict()

export const LoopQueueParamsSchema = z.object({ loopId: LoopIdSchema, op: QueueOpSchema }).strict()

export const LoopBindTabParamsSchema = z
  .object({ loopId: LoopIdSchema, tabId: z.string().min(1), paneKey: z.string().min(1) })
  .strict()

export const LoopIterationsParamsSchema = z
  .object({ loopId: LoopIdSchema, limit: z.number().int().min(1).optional() })
  .strict()
