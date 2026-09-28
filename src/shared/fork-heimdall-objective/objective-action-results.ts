import { z } from 'zod'
import { OWNER_INTERVENTION_TEXT_MAX_LENGTH } from '../fork-heimdall/owner/intervention'
import { OBJECTIVE_PATH_MAX_LENGTH, ObjectiveWorkspacePathSchema } from './contract-types'
import { ObjectiveReviewRoleSchema, ObjectiveVerdictSchema } from './detail-types'
import { ObjectiveActionNaturalKeySchema } from './objective-actions'

const IdSchema = z.string().trim().min(1).max(1_024)
const NaturalKeyResultBase = {
  naturalKey: ObjectiveActionNaturalKeySchema,
  digest: IdSchema
} as const

/** Durable result values emitted by objective action executors. */
export const ObjectiveActionResultSchema = z.discriminatedUnion('kind', [
  z
    .object({ ...NaturalKeyResultBase, kind: z.literal('plan-ingested'), revisionId: IdSchema })
    .strict(),
  z.object({ ...NaturalKeyResultBase, kind: z.literal('plan-activated') }).strict(),
  z.object({ ...NaturalKeyResultBase, kind: z.literal('report-ingested') }).strict(),
  z
    .object({
      ...NaturalKeyResultBase,
      kind: z.literal('node-applied'),
      commitSha: IdSchema
    })
    .strict(),
  z
    .object({
      ...NaturalKeyResultBase,
      kind: z.literal('check-recorded'),
      exitCode: z.number().int().nullable(),
      timedOut: z.boolean()
    })
    .strict(),
  z
    .object({
      ...NaturalKeyResultBase,
      kind: z.literal('verdict-ingested'),
      verdict: ObjectiveVerdictSchema
    })
    .strict(),
  z.object({ ...NaturalKeyResultBase, kind: z.literal('landing-recorded') }).strict(),
  z
    .object({
      naturalKey: ObjectiveActionNaturalKeySchema,
      kind: z.literal('commit-recorded'),
      commitSha: IdSchema,
      contentIdentity: IdSchema,
      outsideTerritoryPaths: z.array(ObjectiveWorkspacePathSchema).max(256)
    })
    .strict(),
  z
    .object({
      naturalKey: ObjectiveActionNaturalKeySchema,
      kind: z.literal('push-recorded'),
      remoteSha: IdSchema
    })
    .strict(),
  z
    .object({
      naturalKey: ObjectiveActionNaturalKeySchema,
      kind: z.literal('review-recorded'),
      reviewNumber: z.number().int().positive().safe(),
      reviewUrl: z.string().trim().url()
    })
    .strict(),
  z
    .object({
      ...NaturalKeyResultBase,
      kind: z.literal('report-accepted'),
      attestation: z.string().trim().min(1).max(OWNER_INTERVENTION_TEXT_MAX_LENGTH),
      rejectionReason: z.string().max(8_192),
      reportedFiles: z.array(z.string().max(OBJECTIVE_PATH_MAX_LENGTH)).max(256),
      observedFiles: z.array(z.string().max(OBJECTIVE_PATH_MAX_LENGTH)).max(256)
    })
    .strict(),
  z
    .object({
      ...NaturalKeyResultBase,
      kind: z.literal('plan-amended'),
      attestation: z.string().trim().min(1).max(OWNER_INTERVENTION_TEXT_MAX_LENGTH),
      ordinal: z.number().int().nonnegative(),
      replayed: z.boolean()
    })
    .strict(),
  z
    .object({
      ...NaturalKeyResultBase,
      kind: z.literal('review-skipped'),
      role: ObjectiveReviewRoleSchema,
      rationale: z.string().trim().min(1).max(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
    })
    .strict(),
  z
    .object({
      ...NaturalKeyResultBase,
      kind: z.literal('check-skipped'),
      rationale: z.string().trim().min(1).max(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
    })
    .strict()
])
export type ObjectiveActionResult = z.infer<typeof ObjectiveActionResultSchema>
