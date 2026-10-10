import { z } from 'zod'
import { WatcherWorkerNavigationSchema } from '../fork-heimdall/fleet-types'
import { WatcherKindIdSchema } from '../fork-heimdall/watcher-types'
import { remoteReaderSchema } from '../fork-heimdall/remote-reader-schemas'
import { openEnum } from '../zod-salvage'
import { NodeIdSchema } from './node-id'
import { PipelineDocumentSchema } from './document-schema'
import { PipelinePinSchema } from './pipeline-pin'

const NODE_STATUSES = [
  'pending',
  'running',
  'waiting',
  'done',
  'failed',
  'skipped',
  'unverifiable',
  'unknown'
] as const
const WAITING_FOR = ['gate', 'choice', 'capability-approval', 'owner'] as const

const PipelineRunDocumentSchema = PipelineDocumentSchema.extend({
  nodes: z
    .array(
      z
        .object({
          id: NodeIdSchema,
          type: z.string().min(1),
          label: z.string().optional()
        })
        .passthrough()
    )
    .min(1)
    .max(64)
})
const PipelineRunDocumentReaderSchema = remoteReaderSchema(PipelineRunDocumentSchema)
export type PipelineRunDocument = z.infer<typeof PipelineRunDocumentReaderSchema>

const PipelineRunPinSchema = PipelinePinSchema.extend({
  scope: openEnum(['builtin', 'repo', 'user', 'unknown'] as const, 'unknown'),
  runNumber: z.number().int().positive().nullable(),
  label: z.string().min(1)
}).strict()

export const PipelineRunNodeViewSchema = z
  .object({
    instanceId: z.string().min(1),
    nodeId: NodeIdSchema,
    type: z.string().min(1),
    label: z.string(),
    status: openEnum(NODE_STATUSES, 'unknown'),
    waitingFor: openEnum(WAITING_FOR, undefined).nullable().optional(),
    escalationId: z.string().min(1).optional(),
    epoch: z.number().int().nonnegative(),
    attempt: z.number().int().nonnegative(),
    round: z.number().int().positive().optional(),
    startedAtMs: z.number().int().nonnegative().optional(),
    elapsedMs: z.number().int().nonnegative().optional(),
    turns: z.number().int().nonnegative(),
    phase: z.string().optional(),
    revision: z.number().int().positive().optional(),
    progress: z
      .object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() })
      .strict()
      .optional(),
    workerNavigation: WatcherWorkerNavigationSchema.optional(),
    usage: z
      .object({
        totalTokens: z.number().int().nonnegative().optional(),
        estimatedCostUsd: z.number().finite().nonnegative().optional(),
        estimate: z.literal(true)
      })
      .strict()
      .optional(),
    warnings: z.array(z.string()).optional(),
    parentInstanceId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    checks: z.array(z.object({ name: z.string(), result: z.unknown() }).strict()).optional()
  })
  .strict()
export type PipelineRunNodeView = z.infer<typeof PipelineRunNodeViewSchema>

export const PipelineRunViewSchema = z
  .object({
    watcherId: z.string().min(1),
    kind: openEnum([...WatcherKindIdSchema.options, 'unknown'] as const, 'unknown'),
    pin: PipelineRunPinSchema,
    document: PipelineRunDocumentReaderSchema,
    nodes: z.array(PipelineRunNodeViewSchema),
    edges: z.array(
      z
        .object({ from: z.string().min(1), to: z.string().min(1), when: z.string().optional() })
        .strict()
    ),
    asOfMs: z.number().int().nonnegative()
  })
  .strict()
export type PipelineRunView = z.infer<typeof PipelineRunViewSchema>
