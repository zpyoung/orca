import { z } from 'zod'

/** Renderer-selected review metadata; the owning host always replaces the identity fields. */
export const HostedReviewEnrollmentCandidateSchema = z.object({
  branch: z.string().trim().min(1).optional(),
  provider: z.enum(['github', 'gitlab']).optional(),
  reviewNumber: z.number().int().positive().safe().optional(),
  reviewUrl: z
    .string()
    .trim()
    .url()
    .refine((value) => value.startsWith('https://') || value.startsWith('http://'))
    .optional(),
  branchUpdateMode: z.enum(['merge-base-update', 'rebase']),
  mergeMethod: z.enum(['merge', 'squash', 'rebase']).nullable()
})

export type HostedReviewEnrollmentCandidate = z.infer<typeof HostedReviewEnrollmentCandidateSchema>
