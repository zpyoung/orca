import { z } from 'zod'
import { OptionalString, requiredNumber, requiredString } from '../schemas'
import { PIPELINE_TEMPLATE_NODE_ID_PATTERN } from '../../../../shared/pipeline-template-types'

// Why: the template layer already enforces these ranges, the id pattern, and id/needs
// referential integrity client-side, but the resolved definition arrives here as untrusted
// RPC input and must be re-validated at the boundary.
const RETRY_MESSAGE = 'onFailure.retries must be an integer between 0 and 10'
const MAX_MINUTES_MESSAGE = 'limits.maxMinutes must be a finite number greater than 0'
const NODE_ID_PATTERN_MESSAGE = `node id must match ${PIPELINE_TEMPLATE_NODE_ID_PATTERN}`
const DUPLICATE_NODE_ID_MESSAGE = 'node ids must be unique across nodes'
const UNKNOWN_NEEDS_MESSAGE = 'needs must reference a declared node id'

const OptionalPipelineRetries = z.number().int(RETRY_MESSAGE).min(0, RETRY_MESSAGE).max(10, RETRY_MESSAGE).optional()
const OptionalPipelineMaxMinutes = z.number().finite(MAX_MINUTES_MESSAGE).gt(0, MAX_MINUTES_MESSAGE).optional()

const PipelineNodeLimits = z.object({ maxMinutes: OptionalPipelineMaxMinutes }).optional()
const PipelineNodeOnFailure = z.object({ retries: OptionalPipelineRetries }).optional()

const PipelineNodeId = requiredString('Missing node id').refine(
  (value) => PIPELINE_TEMPLATE_NODE_ID_PATTERN.test(value),
  NODE_ID_PATTERN_MESSAGE
)

const ResolvedPipelineNodeSchema = z.object({
  id: PipelineNodeId,
  title: requiredString('Missing node title'),
  prompt: requiredString('Missing node prompt'),
  index: requiredNumber('Missing node index'),
  needs: z.array(z.string()),
  harness: requiredString('Missing node harness'),
  model: OptionalString,
  effort: OptionalString,
  limits: PipelineNodeLimits,
  onFailure: PipelineNodeOnFailure
})

const ResolvedPipelineDefinitionSchema = z
  .object({
    templateName: requiredString('Missing templateName'),
    templateVersion: requiredNumber('Missing templateVersion'),
    needsNewerOrca: z.boolean(),
    inputText: z.string(),
    nodes: z.array(ResolvedPipelineNodeSchema).min(1, 'nodes must include at least one node')
  })
  .superRefine((definition, ctx) => {
    const knownIds = new Set(definition.nodes.map((node) => node.id))
    const seenIds = new Set<string>()

    definition.nodes.forEach((node, nodeIndex) => {
      if (seenIds.has(node.id)) {
        ctx.addIssue({ code: 'custom', path: ['nodes', nodeIndex, 'id'], message: DUPLICATE_NODE_ID_MESSAGE })
      }
      seenIds.add(node.id)

      node.needs.forEach((needId, needIndex) => {
        if (!knownIds.has(needId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['nodes', nodeIndex, 'needs', needIndex],
            message: UNKNOWN_NEEDS_MESSAGE
          })
        }
      })
    })
  })

export const PipelineStartParams = z.object({
  worktree: requiredString('Missing worktree'),
  definition: ResolvedPipelineDefinitionSchema
})

export const PipelineRunIdParams = z.object({
  runId: requiredString('Missing runId')
})

export const PipelineListRunsParams = z.object({
  workspaceId: OptionalString
})

export const PipelineSubscribeParams = z.object({
  runId: requiredString('Missing runId')
})

export const PipelineUnsubscribeParams = z.object({
  subscriptionId: requiredString('Missing subscriptionId')
})
