import { z } from 'zod'

// Pinned validation, ported verbatim from the upstream script's
// `finding_id_shape("F")` and `CATEGORY_SHAPE` — not to be loosened.
export const FINDING_ID_PATTERN = /^F[1-9][0-9]*$/
export const FINDING_CATEGORY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const FINDING_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const
export const FindingSeveritySchema = z.enum(FINDING_SEVERITIES)
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>

export const FINDING_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const
export const FindingConfidenceSchema = z.enum(FINDING_CONFIDENCES)
export type FindingConfidence = z.infer<typeof FindingConfidenceSchema>

export const FINDING_STAGES = ['promote', 'refute', 'tiebreak', 'prepass'] as const
export const FindingStageSchema = z.enum(FINDING_STAGES)
export type FindingStage = z.infer<typeof FindingStageSchema>

export const FINDING_DISPOSITIONS = ['standing', 'refuted', 'contested'] as const
export const FindingDispositionSchema = z.enum(FINDING_DISPOSITIONS)
export type FindingDisposition = z.infer<typeof FindingDispositionSchema>

export const FINDING_RECORD_KINDS = ['finding', 'limitation', 'question'] as const
export const FindingRecordKindSchema = z.enum(FINDING_RECORD_KINDS)
export type FindingRecordKind = z.infer<typeof FindingRecordKindSchema>

// Real ids never approach this; capped so a pathological string is a cheap
// reject rather than an unbounded scan, matching the category guard below.
const FINDING_ID_MAX_LENGTH = 20

export const FindingIdSchema = z
  .string()
  .max(FINDING_ID_MAX_LENGTH)
  .refine((value) => value.length <= FINDING_ID_MAX_LENGTH && FINDING_ID_PATTERN.test(value), {
    message: 'must be F followed by a positive integer'
  })

// The promote stage emits `id: null` (or `""`) before the gate assigns one;
// upstream's `assign_ids`/`validate_finding` treat any falsy id as
// unassigned, so both are tolerated here — a supplied id still has to match.
export const FindingIdFieldSchema = z.union([FindingIdSchema, z.literal(''), z.null()]).optional()

// `(-[a-z0-9]+)*` backtracks catastrophically on a long non-match; check the
// length before the regex ever runs, since zod's `.max()` failing does not
// stop `.regex()` from also running.
export const FindingCategorySchema = z
  .string()
  .min(1)
  .max(40)
  .refine((value) => value.length <= 40 && FINDING_CATEGORY_PATTERN.test(value), {
    message: 'must be kebab-case, 1-40 chars'
  })

// Presence is not content: upstream rejects a whitespace-only value on every
// field but `absence`'s `output`, where an empty string is the proof itself.
const nonBlankString = z.string().refine((value) => value.trim().length > 0, {
  message: 'must not be blank'
})

const FileLineEvidenceSchema = z.object({
  kind: z.literal('file-line'),
  ref: nonBlankString,
  quote: nonBlankString
})

const QuoteEvidenceSchema = z.object({
  kind: z.literal('quote'),
  ref: nonBlankString,
  quote: nonBlankString
})

const CommandEvidenceSchema = z.object({
  kind: z.literal('command'),
  command: nonBlankString,
  output: nonBlankString
})

const AbsenceEvidenceSchema = z.object({
  kind: z.literal('absence'),
  command: nonBlankString,
  ref: nonBlankString,
  output: z.string()
})

const PrepassEvidenceSchema = z.object({
  kind: z.literal('prepass'),
  ref: nonBlankString,
  output: nonBlankString
})

export const EvidenceSchema = z.discriminatedUnion('kind', [
  FileLineEvidenceSchema,
  QuoteEvidenceSchema,
  CommandEvidenceSchema,
  AbsenceEvidenceSchema,
  PrepassEvidenceSchema
])
export type Evidence = z.infer<typeof EvidenceSchema>

/**
 * The richest run-file payload: a reviewer's claim plus the evidence gate's
 * verdict on it. `prior_id` is the port's addition for closure rounds — a
 * finding re-emitted in a later round carries the id it had in the earlier
 * one, so the gate can match it against that round's dismissals.
 * `effective_severity`/`blocking` are computed by the evidence gate, never
 * asserted by a stage, and are optional here for exactly that reason.
 */
export const FindingSchema = z.object({
  id: FindingIdFieldSchema,
  severity: FindingSeveritySchema,
  confidence: FindingConfidenceSchema,
  category: FindingCategorySchema,
  claim: nonBlankString,
  evidence: z.array(EvidenceSchema).min(1),
  remediation: nonBlankString,
  patch: z.string().nullable().optional(),
  stage: FindingStageSchema,
  disposition: FindingDispositionSchema.optional(),
  kind: FindingRecordKindSchema.optional(),
  adjudicated_severity: FindingSeveritySchema.optional(),
  prior_id: FindingIdSchema.optional(),
  effective_severity: FindingSeveritySchema.optional(),
  blocking: z.boolean().optional()
})
export type Finding = z.infer<typeof FindingSchema>
