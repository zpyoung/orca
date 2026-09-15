import { z } from 'zod'
import { ReviewDepthSchema, ReviewProfileSchema } from '../../../../shared/review/stage-schemas'
import { defineMethod, InvalidArgumentError, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

const Worktree = z.object({ worktree: requiredString('Missing worktree') })
const Run = Worktree.extend({
  run: requiredString('Missing review run').refine((value) => /^[0-9a-f]{16}$/.test(value), {
    message: 'Invalid review run'
  })
})
const RunCreate = Worktree.extend({
  depth: ReviewDepthSchema.optional(),
  profile: ReviewProfileSchema.optional(),
  orchestrationRunId: z.string().min(1).optional(),
  driverTerminalHandle: z.string().min(1).optional()
})
const Resolve = Run.extend({
  target: requiredString('Missing review target'),
  profile: ReviewProfileSchema,
  criteriaFile: z.string().min(1).optional()
})
const SelectModel = Run.extend({
  authorFamily: z.enum(['anthropic', 'openai', 'google', 'other']),
  reviewer: z.string().min(1).optional()
})
const StagePrompt = Run.extend({ stage: z.enum(['promote', 'refute', 'tiebreak', 'quick']) })
const Claims = Run.extend({ findings: requiredString('Missing findings path') })
const Merge = Run.extend({
  findings: requiredString('Missing findings path'),
  judgments: requiredString('Missing judgments path'),
  stage: z.enum(['refute', 'tiebreak'])
})
const Gate = Run.extend({ depth: ReviewDepthSchema })
const RunFail = Run.extend({ reason: z.string().min(1).optional() })
const Dismiss = Run.extend({
  finding: requiredString('Missing finding id'),
  reason: requiredString('Missing dismissal reason')
})
const Plan = Worktree.extend({
  target: z.string().optional(),
  profile: ReviewProfileSchema.optional(),
  depth: ReviewDepthSchema.optional(),
  authorFamily: z.enum(['anthropic', 'openai', 'google', 'other']).optional(),
  reviewer: z.string().optional()
})

function unavailable(method: string): never {
  throw new InvalidArgumentError(`${method} is not available until artifact capture is configured`)
}

export const REVIEW_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'review.runCreate',
    params: RunCreate,
    handler: (params, { runtime }) => runtime.reviewRunCreate(params.worktree, params)
  }),
  defineMethod({
    name: 'review.resolve',
    params: Resolve,
    handler: () => unavailable('review.resolve')
  }),
  defineMethod({
    name: 'review.prepass',
    params: Run,
    handler: () => unavailable('review.prepass')
  }),
  defineMethod({
    name: 'review.selectModel',
    params: SelectModel,
    handler: () => unavailable('review.selectModel')
  }),
  defineMethod({
    name: 'review.stagePrompt',
    params: StagePrompt,
    handler: () => unavailable('review.stagePrompt')
  }),
  defineMethod({
    name: 'review.claims',
    params: Claims,
    handler: () => unavailable('review.claims')
  }),
  defineMethod({
    name: 'review.merge',
    params: Merge,
    handler: () => unavailable('review.merge')
  }),
  defineMethod({
    name: 'review.gate',
    params: Gate,
    handler: () => unavailable('review.gate')
  }),
  defineMethod({
    name: 'review.manifest',
    params: Run,
    handler: () => unavailable('review.manifest')
  }),
  defineMethod({
    name: 'review.runAbort',
    params: Run,
    handler: (params, { runtime }) => runtime.reviewRunAbort(params.worktree, params.run)
  }),
  defineMethod({
    name: 'review.runList',
    params: Worktree,
    handler: (params, { runtime }) => runtime.reviewRunList(params.worktree)
  }),
  defineMethod({
    name: 'review.runShow',
    params: Run,
    handler: (params, { runtime }) => runtime.reviewRunShow(params.worktree, params.run)
  }),
  defineMethod({
    name: 'review.runFail',
    params: RunFail,
    handler: (params, { runtime }) =>
      runtime.reviewRunFail(params.worktree, params.run, params.reason)
  }),
  defineMethod({
    name: 'review.dismiss',
    params: Dismiss,
    handler: (params, { runtime }) =>
      runtime.reviewDismiss(params.worktree, params.run, params.finding, params.reason)
  }),
  defineMethod({
    name: 'review.staleness',
    params: Run,
    handler: (params, { runtime }) => runtime.reviewStaleness(params.worktree, params.run)
  }),
  defineMethod({
    name: 'review.plan',
    params: Plan,
    handler: () => unavailable('review.plan')
  })
]
