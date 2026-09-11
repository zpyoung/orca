import type { ForkSessionHandoffTemplate } from './handoff-settings-types'

export const HANDOFF_TEMPLATES_MAX = 24
export const HANDOFF_TEMPLATE_NAME_MAX = 80
export const HANDOFF_TEMPLATE_BODY_MAX = 8_000
export const DEFAULT_FORK_SESSION_HANDOFF_TEMPLATE_IDS = [
  'continue-implementation',
  'review-completed-work',
  'debug-failure'
] as const

type NormalizeHandoffTemplatesOptions = {
  createId?: () => string
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function createFallbackId(index: number, seenIds: ReadonlySet<string>): string {
  const base = `handoff-template-${index + 1}`
  if (!seenIds.has(base)) {
    return base
  }
  let suffix = 2
  while (seenIds.has(`${base}-${suffix}`)) {
    suffix += 1
  }
  return `${base}-${suffix}`
}

/** Returns a bounded list of valid handoff templates from persisted input. */
export function normalizeHandoffTemplates(
  value: unknown,
  options: NormalizeHandoffTemplatesOptions = {}
): ForkSessionHandoffTemplate[] {
  if (!Array.isArray(value)) {
    return []
  }

  const normalized: ForkSessionHandoffTemplate[] = []
  const seenIds = new Set<string>()

  for (const [index, row] of value.entries()) {
    if (normalized.length >= HANDOFF_TEMPLATES_MAX) {
      break
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue
    }

    const name = normalizeText((row as { name?: unknown }).name).slice(0, HANDOFF_TEMPLATE_NAME_MAX)
    const body = normalizeText((row as { body?: unknown }).body).slice(0, HANDOFF_TEMPLATE_BODY_MAX)
    if (!name || !body) {
      continue
    }

    let id = normalizeText((row as { id?: unknown }).id)
    if (!id) {
      id = normalizeText(options.createId?.())
      if (!id || seenIds.has(id)) {
        id = createFallbackId(index, seenIds)
      }
    }
    if (seenIds.has(id)) {
      continue
    }

    seenIds.add(id)
    normalized.push({ id, name, body })
  }

  return normalized
}
