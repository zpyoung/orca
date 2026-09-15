import { z } from 'zod'

export const WorkspaceActivityUIUpdateFields = {
  workspaceActivityWindow: z
    .enum(['all', 'live-only', 'today', 'week', 'month', 'custom'])
    .optional(),
  workspaceActivityCustomDays: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
}
