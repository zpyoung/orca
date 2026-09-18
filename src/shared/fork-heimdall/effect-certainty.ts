import { z } from 'zod'

export const EffectCertaintySchema = z.enum(['landed', 'not-landed', 'indeterminate'])
export type EffectCertainty = z.infer<typeof EffectCertaintySchema>

export const WORKER_EXITED_WITHOUT_COMPLETION = 'worker-exited-without-completion'

/** Kind-agnostic; lives beside EffectCertainty rather than in an objective-only module. */
export const ObjectiveFailureClassSchema = z.enum(['infra', 'environment', 'criteria'])
export type ObjectiveFailureClass = z.infer<typeof ObjectiveFailureClassSchema>

export const ActionOutcomeSchema = z
  .object({
    effect: EffectCertaintySchema,
    result: z.unknown().optional(),
    expectedBefore: z.string().optional(),
    expectedAfter: z.string().optional(),
    reason: z.string().optional(),
    failureClass: ObjectiveFailureClassSchema.optional()
  })
  .strict()

export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>

/** Widens resolveOutcome beyond a bare EffectCertainty so async recovery can also classify why. */
export type EffectCertaintyResolution = {
  effect: EffectCertainty
  failureClass?: ObjectiveFailureClass
}

/** Resolves an effect only when the authority shows one of the two expected states. */
export function resolveByExpectedState(
  observed: string,
  expectedBefore: string,
  expectedAfter: string
): EffectCertainty {
  if (observed === expectedAfter) {
    return 'landed'
  }
  if (observed === expectedBefore) {
    return 'not-landed'
  }
  return 'indeterminate'
}
