import { z } from 'zod'
import { NodeIdSchema } from './node-id'

const PointSchema = z.object({ x: z.number(), y: z.number() })
const ViewportSchema = z.object({ x: z.number(), y: z.number(), zoom: z.number() })

export const PipelineLayoutSchema = z.object({
  version: z.literal(1),
  nodes: z.record(NodeIdSchema, PointSchema),
  viewport: ViewportSchema.optional()
})

export const PipelineLayoutWriteSchema = z
  .object({
    version: z.literal(1),
    nodes: z.record(NodeIdSchema, PointSchema.strict()),
    viewport: ViewportSchema.strict().optional()
  })
  .strict()

export type PipelineLayout = z.infer<typeof PipelineLayoutSchema>
export type PipelineLayoutWrite = z.infer<typeof PipelineLayoutWriteSchema>
