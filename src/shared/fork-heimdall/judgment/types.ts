import { z } from 'zod'

const IdSchema = z.string().trim().min(1)
const probabilitySchema = z.number().finite().min(0).max(1)
const probabilityRecordSchema = z.record(IdSchema, probabilitySchema)

export const JudgmentProviderSchema = z.enum(['typesafe', 'openrouter'])
export type JudgmentProvider = z.infer<typeof JudgmentProviderSchema>

function hasNoControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) {
      return false
    }
  }
  return true
}

export const JudgmentModelSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((model) => model.trim().length > 0, 'Model must contain a visible character')
  .refine(hasNoControlCharacters, 'Model must not contain control characters')

const ChoiceQuestionSchema = z
  .object({
    type: z.literal('choice'),
    instructions: z.string().trim().min(1),
    criteria: z
      .record(IdSchema, z.string().nullable())
      .refine((criteria) => Object.keys(criteria).length >= 2, 'Choice requires two options')
      .refine((criteria) => Object.keys(criteria).length <= 255, 'Choice has too many options')
  })
  .strict()

const ScoreQuestionSchema = z
  .object({
    type: z.literal('score'),
    instructions: z.string().trim().min(1),
    criteria: z.array(z.string().trim().min(1)).min(2).max(10)
  })
  .strict()

const NoulQuestionSchema = z
  .object({
    type: z.literal('noul'),
    instructions: z.string().trim().min(1),
    criteria: z
      .object({
        true: z.string().trim().min(1).optional(),
        false: z.string().trim().min(1).optional()
      })
      .strict()
      .optional()
  })
  .strict()

export const JudgmentQuestionSchema = z.discriminatedUnion('type', [
  ChoiceQuestionSchema,
  ScoreQuestionSchema,
  NoulQuestionSchema
])
export type JudgmentQuestion = z.infer<typeof JudgmentQuestionSchema>

const ChoiceAnswerSchema = z
  .object({
    type: z.literal('choice'),
    choice: IdSchema,
    probabilities: probabilityRecordSchema,
    confidence: probabilitySchema
  })
  .strict()

const ScoreAnswerSchema = z
  .object({
    type: z.literal('score'),
    score: z.number().finite(),
    legend: z.record(IdSchema, z.string()),
    probabilities: probabilityRecordSchema,
    confidence: probabilitySchema
  })
  .strict()

const NoulAnswerSchema = z
  .object({
    type: z.literal('noul'),
    noul: probabilitySchema
  })
  .strict()

export const JudgmentAnswerSchema = z.discriminatedUnion('type', [
  ChoiceAnswerSchema,
  ScoreAnswerSchema,
  NoulAnswerSchema
])
export type JudgmentAnswer = z.infer<typeof JudgmentAnswerSchema>

export const JudgmentQuestionRequestSchema = z
  .object({
    id: IdSchema,
    questionId: IdSchema,
    subjectId: IdSchema,
    question: JudgmentQuestionSchema
  })
  .strict()
export type JudgmentQuestionRequest = z.infer<typeof JudgmentQuestionRequestSchema>

export const JudgmentRecordedAnswerSchema = z
  .object({
    questionId: IdSchema,
    subjectId: IdSchema,
    mode: z.enum(['shadow', 'acting']),
    provider: JudgmentProviderSchema.optional(),
    model: JudgmentModelSchema,
    answer: JudgmentAnswerSchema
  })
  .strict()
export type JudgmentRecordedAnswer = z.infer<typeof JudgmentRecordedAnswerSchema>

export const JudgmentSnapshotSchema = z
  .object({
    stateIdentity: IdSchema,
    contentIdentity: IdSchema,
    projectionDigest: IdSchema,
    status: z.enum(['answered', 'unavailable', 'disabled', 'remote', 'pending', 'not-applicable']),
    reason: z.string().min(1).optional(),
    answers: z.record(IdSchema, JudgmentRecordedAnswerSchema),
    notices: z.array(z.string().min(1))
  })
  .strict()
export type JudgmentSnapshot = z.infer<typeof JudgmentSnapshotSchema>
