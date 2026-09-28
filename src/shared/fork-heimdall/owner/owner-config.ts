import { z } from 'zod'

const IdSchema = z.string().trim().min(1).max(512)

/**
 * Configures the long-lived agent an enrollment wakes on a deviation to reason about it and
 * answer with an intervention. Only `claude` is supported in this slice. A resumable, non-PTY
 * structured agent session — what the owner needs to persist across wakes — exists only for
 * claude and codex; every other agent lacks one.
 */
export const WatcherOwnerConfigSchema = z
  .object({
    agent: IdSchema,
    model: IdSchema.optional(),
    effort: IdSchema.optional()
  })
  .strict()
export type WatcherOwnerConfig = z.infer<typeof WatcherOwnerConfigSchema>
