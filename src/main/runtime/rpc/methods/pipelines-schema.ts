import { z } from 'zod'
import { OptionalString, requiredNumber, requiredString } from '../schemas'

// Why: the template layer already enforces these ranges client-side, but the resolved
// definition arrives here as untrusted RPC input and must be re-validated at the boundary.
const RETRY_MESSAGE = 'onFailure.retries must be an integer between 0 and 10'
const MAX_MINUTES_MESSAGE = 'limits.maxMinutes must be a finite number greater than 0'

const OptionalPipelineRetries = z.number().int(RETRY_MESSAGE).min(0, RETRY_MESSAGE).max(10, RETRY_MESSAGE).optional()
const OptionalPipelineMaxMinutes = z.number().finite(MAX_MINUTES_MESSAGE).gt(0, MAX_MINUTES_MESSAGE).optional()

const PipelineNodeLimits = z.object({ maxMinutes: OptionalPipelineMaxMinutes }).optional()
const PipelineNodeOnFailure = z.object({ retries: OptionalPipelineRetries }).optional()

const ResolvedPipelineNodeSchema = z.object({
  id: requiredString('Missing node id'),
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

const ResolvedPipelineDefinitionSchema = z.object({
  templateName: requiredString('Missing templateName'),
  templateVersion: requiredNumber('Missing templateVersion'),
  needsNewerOrca: z.boolean(),
  inputText: z.string(),
  nodes: z.array(ResolvedPipelineNodeSchema)
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
