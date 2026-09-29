import { z } from 'zod'
import type { EnrollResult } from './watcher-types'
import { formatHeimdallEnrollmentRefusal } from './enrollment-refusal-text'

export const HEIMDALL_ENROLLMENT_REFUSAL_ERROR_CODE = 'heimdall_enrollment_refused' as const

const NonBlankIdSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0)

export const HeimdallEnrollmentRefusalErrorDataSchema = z.discriminatedUnion('reason', [
  z
    .object({
      status: z.literal('refused'),
      reason: z.literal('duplicate-workspace'),
      existingWatcherId: NonBlankIdSchema
    })
    .strict(),
  z.object({ status: z.literal('refused'), reason: z.literal('owner-not-executable') }).strict(),
  z
    .object({
      status: z.literal('refused'),
      reason: z.enum(['unknown-kind', 'invalid-payload'])
    })
    .strict()
])
export type HeimdallEnrollmentRefusalErrorData = z.infer<
  typeof HeimdallEnrollmentRefusalErrorDataSchema
>

type HeimdallEnrollmentRefusal = Extract<EnrollResult, { status: 'refused' }>

export function projectHeimdallEnrollmentRefusalErrorData(
  refusal: HeimdallEnrollmentRefusal
): HeimdallEnrollmentRefusalErrorData {
  const data =
    refusal.reason === 'duplicate-workspace'
      ? {
          status: refusal.status,
          reason: refusal.reason,
          existingWatcherId: refusal.existingWatcherId
        }
      : { status: refusal.status, reason: refusal.reason }
  return HeimdallEnrollmentRefusalErrorDataSchema.parse(data)
}

export class HeimdallEnrollmentRefusalError extends Error {
  readonly code = HEIMDALL_ENROLLMENT_REFUSAL_ERROR_CODE
  readonly data: HeimdallEnrollmentRefusalErrorData

  constructor(data: HeimdallEnrollmentRefusalErrorData, message: string) {
    super(message)
    this.name = 'HeimdallEnrollmentRefusalError'
    this.data = data
  }
}

export function heimdallEnrollmentRefusalError(
  refusal: HeimdallEnrollmentRefusal
): HeimdallEnrollmentRefusalError {
  return new HeimdallEnrollmentRefusalError(
    projectHeimdallEnrollmentRefusalErrorData(refusal),
    formatHeimdallEnrollmentRefusal(refusal)
  )
}
