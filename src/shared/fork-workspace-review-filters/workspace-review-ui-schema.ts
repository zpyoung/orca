import { z } from 'zod'

export const WorkspaceReviewUIUpdateFields = {
  hideCompletedReviewWorkspaces: z.boolean().optional(),
  hidePassingCheckWorkspaces: z.boolean().optional()
}
