import type {
  ForkSessionHandoffSettings,
  ForkSessionHandoffTemplate,
  ForkSessionHandoffTemplateMutation
} from '../../../../shared/fork-session-handoff/handoff-settings-types'
import {
  HANDOFF_TEMPLATE_BODY_MAX,
  HANDOFF_TEMPLATE_NAME_MAX
} from '../../../../shared/fork-session-handoff/handoff-template-normalization'
import { getDefaultHandoffTemplates } from '@/lib/fork-session-handoff/handoff-template-catalog'
import { createBrowserUuid } from '@/lib/browser-uuid'

/** Creates a normalized template with a browser-safe unique id. */
export function createTemplateDraft(name: string, body: string): ForkSessionHandoffTemplate {
  return {
    id: `handoff-template-${createBrowserUuid()}`,
    name: name.trim().slice(0, HANDOFF_TEMPLATE_NAME_MAX),
    body: body.trim().slice(0, HANDOFF_TEMPLATE_BODY_MAX)
  }
}

/** Sends an operation for atomic application by the owning settings store. */
export async function persistHandoffTemplateMutation(args: {
  update: (settings: { forkSessionHandoff: ForkSessionHandoffSettings }) => Promise<void>
  mutation: ForkSessionHandoffTemplateMutation
}): Promise<void> {
  await args.update({ forkSessionHandoff: { templateMutation: args.mutation } })
}

/** Persists a steering note as one atomic catalog addition. */
export async function saveHandoffTemplate(args: {
  name: string
  body: string
  update: (settings: { forkSessionHandoff: ForkSessionHandoffSettings }) => Promise<void>
  readTemplates: () => ForkSessionHandoffTemplate[] | undefined
}): Promise<ForkSessionHandoffTemplate | null> {
  if (args.body.trim().length > HANDOFF_TEMPLATE_BODY_MAX) {
    return null
  }
  const template = createTemplateDraft(args.name, args.body)
  await persistHandoffTemplateMutation({
    update: args.update,
    mutation: {
      type: 'add',
      template,
      seedTemplates: getDefaultHandoffTemplates()
    }
  })
  return args.readTemplates()?.find((candidate) => candidate.id === template.id) ?? null
}
