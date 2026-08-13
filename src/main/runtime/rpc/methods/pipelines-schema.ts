import { z } from 'zod'
import { OptionalFiniteNumber, OptionalString, requiredNumber, requiredString } from '../schemas'

const PipelineNodeLimits = z.object({ maxMinutes: OptionalFiniteNumber }).optional()
const PipelineNodeOnFailure = z.object({ retries: OptionalFiniteNumber }).optional()

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
