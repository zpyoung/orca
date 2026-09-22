import { z } from 'zod'
import {
  KindAgnosticInterventionSchema,
  type KindIntervention
} from '../fork-heimdall/owner/intervention'
import type { HostedReviewSitterCapability } from './types'

/** Zod measures sitter rationale with JavaScript `string.length`, not UTF-8 bytes. */
export const HOSTED_REVIEW_SITTER_RATIONALE_MAX_LENGTH = 2_048

const SitterRationaleSchema = z
  .string()
  .trim()
  .min(1)
  .max(HOSTED_REVIEW_SITTER_RATIONALE_MAX_LENGTH)

/** Rungs `actionForIntervention` can rebuild from a snapshot alone, without ledger lookups. */
export const HOSTED_REVIEW_RETRIABLE_RUNGS = [
  'rerun-check',
  'prepare-fix',
  'prepare-conflict-resolution',
  'update-branch',
  'merge',
  'enqueue'
] as const
export type HostedReviewRetriableRung = (typeof HOSTED_REVIEW_RETRIABLE_RUNGS)[number]

export const RetryRungInterventionSchema = z
  .object({
    kind: z.literal('retry-rung'),
    rung: z.enum(HOSTED_REVIEW_RETRIABLE_RUNGS),
    rationale: SitterRationaleSchema
  })
  .strict()
export type RetryRungIntervention = z.infer<typeof RetryRungInterventionSchema>

const HOSTED_REVIEW_CAPABILITY_KEYS = [
  'updateBranch',
  'resolveConflicts',
  'fixChecks',
  'merge'
] as const

export const SkipCapabilityInterventionSchema = z
  .object({
    kind: z.literal('skip-capability'),
    capability: z.enum(HOSTED_REVIEW_CAPABILITY_KEYS),
    rationale: SitterRationaleSchema
  })
  .strict()
export type SkipCapabilityIntervention = z.infer<typeof SkipCapabilityInterventionSchema>

export type HostedReviewSitterSpecificIntervention =
  | RetryRungIntervention
  | SkipCapabilityIntervention

export type HostedReviewSitterIntervention =
  KindIntervention<HostedReviewSitterSpecificIntervention>

export const HostedReviewSitterInterventionSchema = z.discriminatedUnion('kind', [
  ...KindAgnosticInterventionSchema.options,
  RetryRungInterventionSchema,
  SkipCapabilityInterventionSchema
])

/** The sitter capability that governs retrying a given rung, for the owner-grant gate. */
export const RUNG_CAPABILITY: Record<HostedReviewRetriableRung, HostedReviewSitterCapability> = {
  'rerun-check': 'fixChecks',
  'prepare-fix': 'fixChecks',
  'prepare-conflict-resolution': 'resolveConflicts',
  'update-branch': 'updateBranch',
  merge: 'merge',
  enqueue: 'merge'
}

export function describeHostedReviewInterventions(): string {
  const rationaleLimit = `${HOSTED_REVIEW_SITTER_RATIONALE_MAX_LENGTH} JavaScript UTF-16 code units`
  return [
    '{"kind":"retry-rung","rung":"rerun-check|prepare-fix|prepare-conflict-resolution|update-branch|merge|enqueue","rationale":"..."}' +
      ' — force a fresh attempt at a stuck rung. publish-fix and publish-conflict-resolution cannot be' +
      ' retried directly; retry the prepare-* rung instead, the sitter republishes automatically once it' +
      ` lands. merge and enqueue retries are always refused (never unattended). rationale has max ${rationaleLimit}.`,
    '{"kind":"skip-capability","capability":"updateBranch|resolveConflicts|fixChecks|merge","rationale":"..."}' +
      " — bypass this watcher's human-approval gate for its currently desired action under that" +
      ' capability. Refused if the enrollment set the capability off, or if the capability is merge' +
      ` (never unattended). rationale has max ${rationaleLimit}.`
  ].join('\n')
}
