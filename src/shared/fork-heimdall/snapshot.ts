import { z } from 'zod'

export const FreshnessSchema = z.enum(['live', 'cached'])
export type Freshness = z.infer<typeof FreshnessSchema>

export type Snapshot<TWorld> = {
  readonly freshness: Freshness
  readonly contentIdentity: string
  readonly observedAtMs: number
  readonly world: TWorld
}

export type LiveSnapshot<TWorld> = Snapshot<TWorld> & { freshness: 'live' }

/** Builds the mandatory snapshot envelope around a kind-owned world schema. */
export function snapshotSchema<TWorld>(world: z.ZodType<TWorld>): z.ZodType<Snapshot<TWorld>> {
  return z.object({
    freshness: FreshnessSchema,
    contentIdentity: z.string().min(1),
    observedAtMs: z.number().int().nonnegative(),
    world
  })
}

function isLiveSnapshot<TWorld>(snapshot: Snapshot<TWorld>): snapshot is LiveSnapshot<TWorld> {
  return snapshot.freshness === 'live'
}

export function requireLiveSnapshot<TWorld>(snapshot: Snapshot<TWorld>): LiveSnapshot<TWorld> {
  if (!isLiveSnapshot(snapshot)) {
    throw new Error('A cached snapshot cannot resolve an external effect')
  }
  return snapshot
}
