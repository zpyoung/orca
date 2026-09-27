import { z } from 'zod'
import { agentKindSchema } from '../telemetry-property-schemas'

export const terminalDockToggledSchema = z
  .object({ docked: z.boolean(), agent_kind: agentKindSchema })
  .strict()
export const terminalDockPassthroughToggledSchema = z
  .object({ active: z.boolean(), agent_kind: agentKindSchema })
  .strict()
export const terminalDockSendOutcomeSchema = z.enum([
  'observed-cleared',
  'unobservable',
  'may-not-have-sent'
])
export type TerminalDockSendOutcome = z.infer<typeof terminalDockSendOutcomeSchema>
export const terminalDockSendOutcomeEventSchema = z
  .object({ outcome: terminalDockSendOutcomeSchema, agent_kind: agentKindSchema })
  .strict()
