import { z } from 'zod'

/** Identifier fields share a bounded owner-report contract. */
export const OWNER_INTERVENTION_ID_MAX_LENGTH = 1_024
/** Zod measures owner text with JavaScript `string.length`: UTF-16 code units, not UTF-8 bytes. */
export const OWNER_INTERVENTION_TEXT_MAX_LENGTH = 8_192

const IdSchema = z.string().trim().min(1).max(OWNER_INTERVENTION_ID_MAX_LENGTH)

/**
 * The kind-agnostic contract every intervention satisfies. Mirrors `KernelActionSchema`'s
 * passthrough shape so the kernel can hold a value typed `Intervention` without importing any
 * kind's concrete schema; a kind's own strict union structurally satisfies this by construction.
 */
export const InterventionSchema = z.object({ kind: z.string().min(1) }).passthrough()
export type Intervention = z.infer<typeof InterventionSchema>

export const ContinueInterventionSchema = z.object({ kind: z.literal('continue') }).strict()
export type ContinueIntervention = z.infer<typeof ContinueInterventionSchema>

export const AskHumanInterventionSchema = z
  .object({
    kind: z.literal('ask-human'),
    question: z.string().trim().min(1).max(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
  })
  .strict()
export type AskHumanIntervention = z.infer<typeof AskHumanInterventionSchema>

export const AbandonInterventionSchema = z
  .object({
    kind: z.literal('abandon'),
    rationale: z.string().trim().min(1).max(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
  })
  .strict()
export type AbandonIntervention = z.infer<typeof AbandonInterventionSchema>

export const AnswerWorkerInterventionSchema = z
  .object({
    kind: z.literal('answer-worker'),
    messageId: IdSchema,
    answer: z.string().trim().min(1).max(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
  })
  .strict()
export type AnswerWorkerIntervention = z.infer<typeof AnswerWorkerInterventionSchema>

export const StopWorkerInterventionSchema = z
  .object({
    kind: z.literal('stop-worker'),
    dispatchId: IdSchema,
    rationale: z.string().trim().min(1).max(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
  })
  .strict()
export type StopWorkerIntervention = z.infer<typeof StopWorkerInterventionSchema>

export const KindAgnosticInterventionSchema = z.discriminatedUnion('kind', [
  ContinueInterventionSchema,
  AskHumanInterventionSchema,
  AbandonInterventionSchema,
  AnswerWorkerInterventionSchema,
  StopWorkerInterventionSchema
])
/** The five moves every kind's owner can make, regardless of what the kind adds. */
export type KindAgnosticIntervention = z.infer<typeof KindAgnosticInterventionSchema>

/**
 * The full intervention vocabulary a kind exposes to its owning agent: the kind-agnostic moves
 * plus `TKindSpecific`. A kind declares its own alias of this (e.g. `ObjectiveIntervention =
 * KindIntervention<ObjectiveSpecificIntervention>`); the kernel only ever needs the `Intervention`
 * base above, so it stays decoupled from every kind's concrete additions.
 */
export type KindIntervention<TKindSpecific extends Intervention = never> =
  | KindAgnosticIntervention
  | TKindSpecific
