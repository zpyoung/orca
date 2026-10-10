import { z } from 'zod'
import { NodeIdSchema } from './node-id'

export const PipelinePinSchema = z
  .object({
    ref: z.string().min(1).max(300),
    scope: z.enum(['builtin', 'repo', 'user']),
    id: NodeIdSchema,
    contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    documentVersion: z.literal(1)
  })
  .strict()
export type PipelinePin = z.infer<typeof PipelinePinSchema>
