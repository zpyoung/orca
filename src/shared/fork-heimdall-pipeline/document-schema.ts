import { z } from 'zod'
import {
  OBJECTIVE_AGENT_ID_MAX_LENGTH,
  OBJECTIVE_GATES_MAX,
  OBJECTIVE_LAUNCH_MODEL_MAX_LENGTH,
  ObjectiveEnrollmentPayloadSchema,
  ObjectiveGateSchema,
  ObjectiveLandingBarSchema,
  ObjectiveRoleAgentsSchema,
  ObjectiveTierSchema,
  ObjectiveLaunchEffortSchema
} from '../fork-heimdall-objective/contract-types'
import { HostedReviewEnrollmentCandidateSchema } from '../fork-hosted-review-sitter/enrollment-candidate'
import { SCRIPT_ENV_NAME_PATTERN } from './script-env'
import { NodeIdSchema } from './node-id'

export const PIPELINE_NODE_TYPES = [
  'agent',
  'check',
  'script',
  'decision',
  'loop',
  'swarm',
  'merge',
  'gate',
  'land',
  'objective',
  'pr-sitter'
] as const

export type NodeType = (typeof PIPELINE_NODE_TYPES)[number]
export const PIPELINE_NODE_TYPE_DISPLAY_NAMES: Readonly<Record<NodeType, string>> = {
  agent: 'Agent',
  check: 'Check',
  script: 'Script',
  decision: 'Decision',
  loop: 'Loop',
  swarm: 'Swarm',
  merge: 'Merge',
  gate: 'Human gate',
  land: 'Land',
  objective: 'Objective',
  'pr-sitter': 'PR sitter'
}

export const PipelineInputNameSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,62}$/u)
export const PipelineOutputNameSchema = PipelineInputNameSchema
export const AgentHarnessSchema = z.string().trim().min(1).max(OBJECTIVE_AGENT_ID_MAX_LENGTH)
export const AgentModelSchema = z.string().trim().min(1).max(OBJECTIVE_LAUNCH_MODEL_MAX_LENGTH)
export const AgentEffortSchema = ObjectiveLaunchEffortSchema

export const PIPELINE_CAPABILITY_KEYS = [
  'agent',
  'check',
  'script',
  'integrate',
  'push',
  'land',
  'updateBranch',
  'resolveConflicts',
  'fixChecks',
  'merge',
  'gate',
  'pipeline'
] as const
export type PipelineCapabilityKey = (typeof PIPELINE_CAPABILITY_KEYS)[number]
export const PipelineCapabilityKeySchema = z.enum(PIPELINE_CAPABILITY_KEYS)

export const PipelineRefStringSchema = z
  .string()
  .regex(
    /^\$(?:run\.inputs\.[a-zA-Z][a-zA-Z0-9_]{0,62}|[a-z][a-z0-9-]{0,62}\.outputs\.[a-zA-Z][a-zA-Z0-9_]{0,62}|task\.(?:id|title|spec))$/u
  )
export const PipelineOutputRefSchema = z
  .string()
  .regex(/^\$[a-z][a-z0-9-]{0,62}\.outputs\.[a-zA-Z][a-zA-Z0-9_]{0,62}$/u)

const CapabilityModeSchema = z.enum(['off', 'gated', 'on'])
const ScalarSchema = z.union([z.string(), z.number(), z.boolean()])
const InputSchema = z
  .object({
    type: z.enum(['text', 'number', 'boolean']),
    label: z.string().optional(),
    required: z.boolean().default(false),
    default: ScalarSchema.optional()
  })
  .strict()
const InputsSchema = z.record(PipelineInputNameSchema, InputSchema)
export const PipelineOutputTypeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text') }).strict(),
  z.object({ type: z.literal('number') }).strict(),
  z.object({ type: z.literal('boolean') }).strict(),
  z.object({ type: z.literal('json') }).strict(),
  z.object({ type: z.literal('file') }).strict(),
  z.object({ type: z.literal('taskList') }).strict(),
  z.object({ type: z.literal('verdict') }).strict(),
  z
    .object({
      type: z.literal('enum'),
      values: z.array(z.string()).min(1).max(16)
    })
    .strict()
])
export type PipelineOutputType = z.infer<typeof PipelineOutputTypeSchema>

const PipelineOutputsSchema = z
  .record(PipelineOutputNameSchema, PipelineOutputTypeSchema)
  .refine((outputs) => Object.keys(outputs).length <= 16, 'At most 16 outputs are allowed')
const RetrySchema = z.number().int().min(0).max(5)
const TimeLimitMinutesSchema = z.number().int().min(1).max(1440)
const CommandSchema = z.string().min(1).max(8192)
const AfterEntrySchema = z.union([
  NodeIdSchema,
  z.object({ node: NodeIdSchema, when: z.string() }).strict()
])
const BaseNodeFields = {
  id: NodeIdSchema,
  label: z.string().max(80).optional(),
  after: z.array(AfterEntrySchema).optional()
}
const OnFailSchema = z.object({ sendBackTo: NodeIdSchema.optional() }).strict()
const AgentChildSchema = z
  .object({
    harness: AgentHarnessSchema,
    model: AgentModelSchema.optional(),
    effort: AgentEffortSchema.optional(),
    prompt: z.string().max(32_768),
    outputs: PipelineOutputsSchema.optional(),
    retry: RetrySchema.optional(),
    timeLimitMinutes: TimeLimitMinutesSchema.optional()
  })
  .strict()

export const AgentNodeSchema = z
  .object({
    ...BaseNodeFields,
    type: z.literal('agent'),
    harness: AgentHarnessSchema.optional(),
    model: AgentModelSchema.optional(),
    effort: AgentEffortSchema.optional(),
    prompt: z.string().max(32_768),
    outputs: PipelineOutputsSchema.optional(),
    retry: RetrySchema.optional(),
    timeLimitMinutes: TimeLimitMinutesSchema.optional(),
    onFail: OnFailSchema.optional()
  })
  .strict()
export const CheckNodeSchema = z
  .object({
    ...BaseNodeFields,
    type: z.literal('check'),
    command: CommandSchema,
    timeoutSeconds: z.number().int().min(10).max(14_400).default(1800),
    retry: RetrySchema.optional(),
    onFail: OnFailSchema.optional()
  })
  .strict()
export const ScriptNodeSchema = z
  .object({
    ...BaseNodeFields,
    type: z.literal('script'),
    command: CommandSchema,
    capability: z.enum(['script', 'push', 'land', 'merge', 'check']),
    inputs: z.record(z.string().regex(SCRIPT_ENV_NAME_PATTERN), PipelineRefStringSchema).optional(),
    timeoutSeconds: z.number().int().min(10).max(14_400).optional(),
    outputs: z
      .object({
        stdout: z
          .object({ type: z.literal('text') })
          .strict()
          .optional()
      })
      .strict()
      .optional()
  })
  .strict()
export const DecisionNodeSchema = z
  .object({ ...BaseNodeFields, type: z.literal('decision'), on: PipelineOutputRefSchema })
  .strict()
export const LoopNodeSchema = z
  .object({
    ...BaseNodeFields,
    type: z.literal('loop'),
    body: z.array(NodeIdSchema).min(1),
    until: PipelineOutputRefSchema,
    maxRounds: z.number().int().min(1).max(10)
  })
  .strict()
export const SwarmNodeSchema = z
  .object({
    ...BaseNodeFields,
    type: z.literal('swarm'),
    from: PipelineOutputRefSchema,
    maxParallel: z.number().int().min(1).max(5).default(5),
    worktree: z.enum(['own', 'shared']).default('own'),
    child: AgentChildSchema
  })
  .strict()
export const MergeNodeSchema = z
  .object({ ...BaseNodeFields, type: z.literal('merge'), from: NodeIdSchema })
  .strict()
export const GateNodeSchema = z
  .object({
    ...BaseNodeFields,
    type: z.literal('gate'),
    label: z.string().min(1).max(80),
    sendBackTo: NodeIdSchema.optional(),
    notify: z.boolean().default(true)
  })
  .strict()
export const LandNodeSchema = z
  .object({
    ...BaseNodeFields,
    type: z.literal('land'),
    title: z.string().optional(),
    body: z.string().optional(),
    draft: z.boolean().default(false),
    commitMessage: z.string().optional()
  })
  .strict()
export const ObjectiveNodeSchema = z
  .object({
    ...BaseNodeFields,
    type: z.literal('objective'),
    tier: ObjectiveTierSchema,
    landingBar: ObjectiveLandingBarSchema,
    checks: z.array(ObjectiveGateSchema).max(OBJECTIVE_GATES_MAX).optional(),
    roleAgents: ObjectiveRoleAgentsSchema.optional(),
    maxConcurrency: ObjectiveEnrollmentPayloadSchema.shape.maxConcurrency.optional(),
    lanesEnabled: ObjectiveEnrollmentPayloadSchema.shape.lanesEnabled
  })
  .strict()
export const PrSitterNodeSchema = z
  .object({
    ...BaseNodeFields,
    type: z.literal('pr-sitter'),
    repeatFixLimit: z.number().int().min(1).max(10).default(3),
    branchUpdateMode: HostedReviewEnrollmentCandidateSchema.shape.branchUpdateMode.optional(),
    mergeMethod: HostedReviewEnrollmentCandidateSchema.shape.mergeMethod.optional(),
    mergeCheckScope: HostedReviewEnrollmentCandidateSchema.shape.mergeCheckScope
  })
  .strict()

export const PipelineNodeSchema = z.discriminatedUnion('type', [
  AgentNodeSchema,
  CheckNodeSchema,
  ScriptNodeSchema,
  DecisionNodeSchema,
  LoopNodeSchema,
  SwarmNodeSchema,
  MergeNodeSchema,
  GateNodeSchema,
  LandNodeSchema,
  ObjectiveNodeSchema,
  PrSitterNodeSchema
])
export type PipelineNode = z.infer<typeof PipelineNodeSchema>
export type PipelineAgentNode = z.infer<typeof AgentNodeSchema>
export type PipelineCheckNode = z.infer<typeof CheckNodeSchema>
export type PipelineScriptNode = z.infer<typeof ScriptNodeSchema>
export type PipelineDecisionNode = z.infer<typeof DecisionNodeSchema>
export type PipelineLoopNode = z.infer<typeof LoopNodeSchema>
export type PipelineSwarmNode = z.infer<typeof SwarmNodeSchema>
export type PipelineMergeNode = z.infer<typeof MergeNodeSchema>
export type PipelineGateNode = z.infer<typeof GateNodeSchema>
export type PipelineLandNode = z.infer<typeof LandNodeSchema>
export type PipelineObjectiveNode = z.infer<typeof ObjectiveNodeSchema>
export type PipelinePrSitterNode = z.infer<typeof PrSitterNodeSchema>

const DefaultsSchema = z
  .object({
    harness: AgentHarnessSchema.optional(),
    model: AgentModelSchema.optional(),
    effort: AgentEffortSchema.optional(),
    retry: RetrySchema.optional(),
    timeLimitMinutes: TimeLimitMinutesSchema.optional()
  })
  .strict()

const ImplicitTaskInput = { type: 'text', required: true } as const
export const PipelineDocumentSchema = z
  .object({
    version: z.literal(1),
    id: NodeIdSchema,
    name: z.string().min(1).max(120),
    description: z.string().max(2000).optional(),
    inputs: InputsSchema.default({ task: ImplicitTaskInput }),
    capabilities: z.record(z.string(), CapabilityModeSchema).optional(),
    defaults: DefaultsSchema.optional(),
    nodes: z.array(PipelineNodeSchema).min(1).max(64)
  })
  .strict()
export type PipelineDocument = z.infer<typeof PipelineDocumentSchema>
