import { z } from 'zod'
import type { HostedReviewEnrollmentPayload } from '../../shared/fork-hosted-review-sitter/types'

export const enrollmentPayloadSchema = z.object({
  branch: z.string().trim().min(1),
  provider: z.enum(['github', 'gitlab']),
  reviewNumber: z.number().int().positive().safe(),
  reviewUrl: z
    .string()
    .trim()
    .url()
    .refine((value) => value.startsWith('https://') || value.startsWith('http://')),
  branchUpdateMode: z.enum(['merge-base-update', 'rebase']),
  mergeMethod: z.enum(['merge', 'squash', 'rebase']).nullable(),
  mergeCheckScope: z.enum(['required', 'all']).default('all')
})

export function parseHostedReviewEnrollmentPayload(
  value: unknown
): HostedReviewEnrollmentPayload | null {
  const parsed = enrollmentPayloadSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
