import { z } from 'zod'
import { ObjectiveNewWorktreeRequestSchema } from '../fork-heimdall-objective/contract-types'
import { PipelineDocumentSchema, PipelineInputNameSchema } from './document-schema'
import { PipelinePinSchema } from './pipeline-pin'
import { PipelineSourceTextSchema } from './pipeline-source'

const RunInputValueSchema = z.union([z.string(), z.number(), z.boolean()])

export const PipelineEnrollmentPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    pin: PipelinePinSchema,
    document: PipelineDocumentSchema,
    sourceText: PipelineSourceTextSchema,
    runInputs: z.record(PipelineInputNameSchema, RunInputValueSchema),
    workspaceKind: z.enum(['git', 'folder'])
  })
  .strict()
export type PipelineEnrollmentPayload = z.infer<typeof PipelineEnrollmentPayloadSchema>

export const PipelineEnrollmentRequestSchema = PipelineEnrollmentPayloadSchema.extend({
  newWorktree: ObjectiveNewWorktreeRequestSchema.optional()
}).strict()
export type PipelineEnrollmentRequest = z.infer<typeof PipelineEnrollmentRequestSchema>
