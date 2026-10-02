import { z } from 'zod'
import { WatcherTargetSchema } from '../fork-heimdall/fleet-types'
import { NodeIdSchema } from './node-id'
import { PipelineDocumentSchema } from './document-schema'
import { PipelineRunViewSchema } from './run-view-types'
import { PipelineSourceTextSchema } from './pipeline-source'

const IdSchema = z.string().trim().min(1)
const PipelineScopeSchema = z.enum(['builtin', 'repo', 'user'])
const PipelineValidationCodeSchema = z.enum([
  'yaml-parse',
  'schema',
  'schema-version-unsupported',
  'id-mismatch',
  'duplicate-node-id',
  'unknown-node-type',
  'dangling-edge',
  'cycle',
  'missing-field',
  'invalid-output-ref',
  'ref-not-upstream',
  'decision-when-unknown',
  'when-without-decision',
  'loop-body-invalid',
  'loop-until-invalid',
  'git-only-node-in-folder',
  'own-worktree-in-folder',
  'objective-not-sole-node',
  'multiple-pr-sitter',
  'pr-sitter-without-land',
  'multiple-land',
  'merge-source-not-swarm',
  'send-back-not-ancestor',
  'capability-unknown',
  'node-type-unsupported-by-host',
  'ref-in-script-command',
  'script-env-denied'
])

export const PipelineWorkspaceSelectorSchema = z
  .object({ repoId: IdSchema, worktreeId: IdSchema.nullable() })
  .strict()
export type PipelineWorkspaceSelector = z.infer<typeof PipelineWorkspaceSelectorSchema>

const PipelineValidationErrorSchema = z
  .object({
    nodeId: z.string().nullable(),
    code: PipelineValidationCodeSchema,
    message: z.string(),
    path: z.array(z.union([z.string(), z.number()])).optional(),
    line: z.number().int().positive().optional()
  })
  .strict()

export const PipelineListRequestSchema = z
  .object({ workspace: PipelineWorkspaceSelectorSchema })
  .strict()
export type PipelineListRequest = z.infer<typeof PipelineListRequestSchema>

const PipelineLiveRunSchema = z
  .object({
    watcherId: IdSchema,
    runNumber: z.number().int().positive().nullable(),
    contentHash: z.string().nullable()
  })
  .strict()

export const PipelineListResponseSchema = z
  .object({
    pipelines: z.array(
      z
        .object({
          ref: z.string().min(1),
          scope: PipelineScopeSchema,
          id: NodeIdSchema,
          name: z.string(),
          valid: z.boolean(),
          errorCount: z.number().int().nonnegative(),
          contentHash: z.string().nullable(),
          liveRuns: z.array(PipelineLiveRunSchema)
        })
        .strict()
    )
  })
  .strict()
export type PipelineListResponse = z.infer<typeof PipelineListResponseSchema>

export const PipelineResolveRequestSchema = z
  .object({ workspace: PipelineWorkspaceSelectorSchema, ref: z.string().min(1).max(300) })
  .strict()
export type PipelineResolveRequest = z.infer<typeof PipelineResolveRequestSchema>

export const PipelineResolveResponseSchema = z
  .object({
    ref: z.string().min(1).max(300),
    scope: PipelineScopeSchema,
    id: NodeIdSchema,
    sourceText: PipelineSourceTextSchema,
    layoutText: z.string().nullable(),
    document: PipelineDocumentSchema.nullable(),
    contentHash: z.string().nullable(),
    errors: z.array(PipelineValidationErrorSchema)
  })
  .strict()
export type PipelineResolveResponse = z.infer<typeof PipelineResolveResponseSchema>

const PipelinePersonalReadRequestSchema = z
  .object({ op: z.literal('read'), id: NodeIdSchema })
  .strict()
const PipelinePersonalWriteRequestSchema = z
  .object({
    op: z.literal('write'),
    id: NodeIdSchema,
    yamlText: PipelineSourceTextSchema,
    layoutText: z.string().nullable().optional(),
    expectedSignature: z.string().min(1).optional()
  })
  .strict()
const PipelinePersonalListRequestSchema = z.object({ op: z.literal('list') }).strict()
const PipelinePersonalStatRequestSchema = z
  .object({ op: z.literal('stat'), id: NodeIdSchema })
  .strict()
export const PipelinePersonalDeleteRequestSchema = z
  .object({
    op: z.literal('delete'),
    id: NodeIdSchema,
    expectedSignature: z.string().min(1).optional()
  })
  .strict()
export type PipelinePersonalDeleteRequest = z.infer<typeof PipelinePersonalDeleteRequestSchema>

export const PipelinePersonalRequestSchema = z.discriminatedUnion('op', [
  PipelinePersonalReadRequestSchema,
  PipelinePersonalWriteRequestSchema,
  PipelinePersonalListRequestSchema,
  PipelinePersonalStatRequestSchema,
  PipelinePersonalDeleteRequestSchema
])
export type PipelinePersonalRequest = z.infer<typeof PipelinePersonalRequestSchema>

export const PipelinePersonalResponseSchema = z.union([
  z
    .object({
      yamlText: PipelineSourceTextSchema,
      layoutText: z.string().nullable(),
      signature: z.string()
    })
    .strict(),
  z.object({ status: z.literal('written'), signature: z.string() }).strict(),
  z.object({ status: z.literal('conflict'), current: z.string().nullable() }).strict(),
  z
    .object({ pipelines: z.array(z.object({ id: NodeIdSchema, name: z.string() }).strict()) })
    .strict(),
  z.object({ signature: z.string().nullable() }).strict(),
  z
    .object({
      status: z.enum(['deleted', 'not-found']),
      current: z.string().nullable().optional()
    })
    .strict()
])
export type PipelinePersonalResponse = z.infer<typeof PipelinePersonalResponseSchema>

export const PipelineEnsureTrackedRequestSchema = z
  .object({
    workspace: PipelineWorkspaceSelectorSchema,
    pipelineId: NodeIdSchema,
    reinclude: z.literal(true).optional()
  })
  .strict()
export type PipelineEnsureTrackedRequest = z.infer<typeof PipelineEnsureTrackedRequestSchema>

export const PipelineEnsureTrackedResponseSchema = z
  .object({
    status: z.enum(['tracked', 'rewrote-orca-line', 'still-ignored']),
    detail: z.string().optional()
  })
  .strict()
export type PipelineEnsureTrackedResponse = z.infer<typeof PipelineEnsureTrackedResponseSchema>

export const PipelineRunViewRequestSchema = z.object({ target: WatcherTargetSchema }).strict()
export const PipelineRunViewResponseSchema = PipelineRunViewSchema
export type PipelineRunViewRequest = z.infer<typeof PipelineRunViewRequestSchema>
export type PipelineRunViewResponse = z.infer<typeof PipelineRunViewResponseSchema>
