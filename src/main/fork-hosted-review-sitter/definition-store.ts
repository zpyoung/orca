import { z } from 'zod'
import type { HostedReviewSitterDefinition } from '../../shared/fork-hosted-review-sitter/types'
import type { HostedReviewSitterArmInput } from '../../shared/fork-hosted-review-sitter/api'
import type { StoreRuntimeState } from '../persistence/loading-store/store-runtime-state'
import type { WriteSchedulingOperations } from '../persistence/loading-store/write-scheduling'
import { scheduleSave } from '../persistence/loading-store/write-scheduling'

const DEFINITION_FIELD = 'hostedReviewSitterDefinitions' as const

type HostedReviewSitterPersistedState = StoreRuntimeState['state'] & {
  [DEFINITION_FIELD]?: unknown
}

type DefinitionPersistenceRuntime = Pick<
  StoreRuntimeState,
  'flushOrThrow' | 'state' | 'writesFrozen'
>

const definitionPersistenceContext = Symbol('HostedReviewSitterDefinitionPersistence')
type DefinitionPersistenceContext = {
  runtime: DefinitionPersistenceRuntime
  scheduling: WriteSchedulingOperations
}

const HostedReviewSitterDefinitionSchema = z.object({
  id: z.string().trim().min(1),
  enabled: z.boolean(),
  repoId: z.string().trim().min(1),
  worktreeId: z.string().trim().min(1),
  repoPath: z.string().trim().min(1),
  branch: z.string().trim().min(1),
  provider: z.enum(['github', 'gitlab']),
  reviewNumber: z.number().int().positive().safe(),
  reviewUrl: z
    .string()
    .trim()
    .url()
    .refine((value) => value.startsWith('https://') || value.startsWith('http://')),
  capabilities: z.object({
    updateBranch: z.enum(['off', 'gated', 'on']),
    resolveConflicts: z.enum(['off', 'gated', 'on']),
    fixChecks: z.enum(['off', 'gated', 'on']),
    merge: z.enum(['off', 'gated', 'on'])
  }),
  activeBudgetMs: z.number().int().positive().safe(),
  branchUpdateMode: z.enum(['merge-base-update', 'rebase']),
  mergeMethod: z.enum(['merge', 'squash', 'rebase']).nullable()
})

export function parseHostedReviewSitterDefinition(
  value: unknown
): HostedReviewSitterDefinition | null {
  const parsed = HostedReviewSitterDefinitionSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
const HostedReviewSitterArmInputSchema = HostedReviewSitterDefinitionSchema.omit({
  id: true,
  enabled: true
})

export function parseHostedReviewSitterArmInput(value: unknown): HostedReviewSitterArmInput | null {
  const parsed = HostedReviewSitterArmInputSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function parseHostedReviewSitterDefinitions(value: unknown): HostedReviewSitterDefinition[] {
  if (!Array.isArray(value)) {
    return []
  }
  const definitions: HostedReviewSitterDefinition[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    const definition = parseHostedReviewSitterDefinition(candidate)
    if (definition && !seen.has(definition.id)) {
      definitions.push(definition)
      seen.add(definition.id)
    }
  }
  return definitions
}

export class HostedReviewSitterDefinitionPersistence {
  readonly [definitionPersistenceContext]: DefinitionPersistenceContext

  constructor(runtime: DefinitionPersistenceRuntime, scheduling: WriteSchedulingOperations) {
    this[definitionPersistenceContext] = { runtime, scheduling }
  }

  getHostedReviewSitterDefinitions(): HostedReviewSitterDefinition[] {
    const state = this[definitionPersistenceContext].runtime
      .state as HostedReviewSitterPersistedState
    return parseHostedReviewSitterDefinitions(state[DEFINITION_FIELD])
  }

  replaceHostedReviewSitterDefinitionsAndFlush(
    definitions: readonly HostedReviewSitterDefinition[]
  ): void {
    const { runtime, scheduling } = this[definitionPersistenceContext]
    if (runtime.writesFrozen) {
      throw new Error('Cannot persist hosted review sitters while writes are frozen')
    }
    const next = parseHostedReviewSitterDefinitions(definitions)
    if (next.length !== definitions.length) {
      throw new Error('Cannot persist invalid hosted review sitter definitions')
    }
    const state = runtime.state as HostedReviewSitterPersistedState
    const previous = state[DEFINITION_FIELD]
    state[DEFINITION_FIELD] = next
    scheduleSave(scheduling)
    try {
      runtime.flushOrThrow()
    } catch (error) {
      state[DEFINITION_FIELD] = previous
      throw error
    }
  }
}

export function installHostedReviewSitterDefinitionPersistenceContext(
  target: object,
  source: HostedReviewSitterDefinitionPersistence
): void {
  Object.defineProperty(target, definitionPersistenceContext, {
    value: source[definitionPersistenceContext]
  })
}
