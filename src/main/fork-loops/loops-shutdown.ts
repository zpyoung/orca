import type { LoopService } from './loop-service'

/** Kept apart from registration so the quit path imports no runtime graph. */
export function beginLoopsShutdown(service: LoopService | null): Promise<void> {
  return service?.shutdown() ?? Promise.resolve()
}
