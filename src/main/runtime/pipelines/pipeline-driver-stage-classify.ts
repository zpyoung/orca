export type PipelinePrelaunchStage = 'B' | 'C'

/**
 * Absence of a spawn-attempt row is the only durable pre-spawn proof; its presence, committed
 * or not, cannot rule out an agent having run, so it floors the classification at C — the
 * conservative default stage-U reconciliation also resolves to.
 */
export function classifyPrelaunchStage(
  spawnReceipt: { spawn_attempt_at: string; spawn_committed_at: string | null } | undefined
): PipelinePrelaunchStage {
  return spawnReceipt === undefined ? 'B' : 'C'
}

type WorkerEffectLike = { kind?: unknown; role?: unknown; action?: unknown; id?: unknown }

export function extractDispatchTerminalHandle(effects: readonly unknown[]): string | undefined {
  for (const effect of effects) {
    const candidate = effect as WorkerEffectLike
    if (
      candidate?.kind === 'terminal' &&
      candidate.role === 'agent' &&
      candidate.action === 'created' &&
      typeof candidate.id === 'string'
    ) {
      return candidate.id
    }
  }
  return undefined
}
