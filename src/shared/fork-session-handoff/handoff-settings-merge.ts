import type { GlobalSettings } from '../global-settings-types'
import {
  DEFAULT_FORK_SESSION_HANDOFF_TEMPLATE_IDS,
  HANDOFF_TEMPLATES_MAX,
  normalizeHandoffTemplates
} from './handoff-template-normalization'
import type {
  ForkSessionHandoffSettings,
  ForkSessionHandoffTemplate
} from './handoff-settings-types'

const DEFAULT_TEMPLATE_IDS: ReadonlySet<string> = new Set(DEFAULT_FORK_SESSION_HANDOFF_TEMPLATE_IDS)

type TemplateMutationResult = {
  applied: boolean
  templates: ForkSessionHandoffTemplate[] | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function applyTemplateMutation(
  current: ForkSessionHandoffTemplate[] | undefined,
  value: unknown
): TemplateMutationResult {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return { applied: false, templates: current }
  }
  if (value.type === 'reset') {
    return { applied: true, templates: undefined }
  }
  const seedTemplates = normalizeHandoffTemplates(value.seedTemplates)
  const templates = current === undefined ? seedTemplates : normalizeHandoffTemplates(current)

  if (value.type === 'add') {
    const [template] = normalizeHandoffTemplates([value.template])
    if (
      !template ||
      templates.length >= HANDOFF_TEMPLATES_MAX ||
      templates.some((candidate) => candidate.id === template.id)
    ) {
      return { applied: false, templates: current }
    }
    return { applied: true, templates: [...templates, template] }
  }
  if (value.type === 'update' && typeof value.id === 'string' && isRecord(value.patch)) {
    const name = typeof value.patch.name === 'string' ? value.patch.name : ''
    const body = typeof value.patch.body === 'string' ? value.patch.body : ''
    if (!name.trim() || !body.trim() || !templates.some((template) => template.id === value.id)) {
      return { applied: false, templates: current }
    }
    return {
      applied: true,
      templates: normalizeHandoffTemplates(
        templates.map((template) =>
          template.id === value.id ? { ...template, name, body } : template
        )
      )
    }
  }
  if (value.type === 'remove' && typeof value.id === 'string') {
    if (!templates.some((template) => template.id === value.id)) {
      return { applied: false, templates: current }
    }
    return {
      applied: true,
      templates: templates.filter((template) => template.id !== value.id)
    }
  }
  return { applied: false, templates: current }
}

/** Merges a nested patch without letting sibling handoff preferences clobber one another. */
export function mergeForkSessionHandoffSettings(
  current: GlobalSettings,
  updates: Partial<GlobalSettings>
): Partial<Pick<GlobalSettings, 'forkSessionHandoff'>> {
  if (!('forkSessionHandoff' in updates)) {
    return {}
  }
  const patch = updates.forkSessionHandoff
  if (patch === undefined) {
    return { forkSessionHandoff: undefined }
  }

  const { templateMutation, ...persistedPatch } = patch
  const { templateMutation: _currentMutation, ...currentSettings } =
    current.forkSessionHandoff ?? {}
  const templatesWereUpdated = 'templates' in persistedPatch
  let templates = templatesWereUpdated
    ? persistedPatch.templates === undefined
      ? undefined
      : normalizeHandoffTemplates(persistedPatch.templates)
    : currentSettings.templates
  // a patch carrying both an explicit templates array and a mutation means both, so the mutation
  // composes onto that write instead of being computed against the pre-patch list
  const mutation = applyTemplateMutation(templates, templateMutation)
  if (mutation.applied) {
    templates = mutation.templates
  }

  const merged: ForkSessionHandoffSettings = {
    ...currentSettings,
    ...persistedPatch,
    ...(templatesWereUpdated || mutation.applied ? { templates } : {})
  }
  if (merged.lastTemplateId) {
    const availableIds =
      templates === undefined
        ? DEFAULT_TEMPLATE_IDS
        : new Set(normalizeHandoffTemplates(templates).map((template) => template.id))
    if (!availableIds.has(merged.lastTemplateId)) {
      merged.lastTemplateId = null
    }
  }

  return { forkSessionHandoff: merged }
}
