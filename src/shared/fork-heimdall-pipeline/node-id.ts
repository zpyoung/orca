import { z } from 'zod'

export const NodeIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u)
export type NodeId = z.infer<typeof NodeIdSchema>
