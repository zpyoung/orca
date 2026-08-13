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

export const FindingIdSchema = z.string().regex(FINDING_ID_PATTERN)
export const FindingCategorySchema = z.string().min(1).max(40).regex(FINDING_CATEGORY_PATTERN)

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
  id: FindingIdSchema.optional(),
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
