import { describe, expect, it } from 'vitest'
import { AGENT_KIND_VALUES, eventSchemas, terminalDockSendOutcomeSchema } from '../telemetry-events'

describe('terminal dock telemetry schemas', () => {
  it('accepts dock and passthrough toggle states with every agent kind', () => {
    for (const agent_kind of AGENT_KIND_VALUES) {
      expect(
        eventSchemas.terminal_dock_toggled.safeParse({ docked: true, agent_kind }).success
      ).toBe(true)
      expect(
        eventSchemas.terminal_dock_passthrough_toggled.safeParse({ active: false, agent_kind })
          .success
      ).toBe(true)
    }
  })

  it('accepts every send outcome counter value', () => {
    for (const outcome of terminalDockSendOutcomeSchema.options) {
      expect(
        eventSchemas.terminal_dock_send_outcome.safeParse({ outcome, agent_kind: 'codex' }).success
      ).toBe(true)
    }
  })

  it('rejects malformed and privacy-unsafe payloads', () => {
    expect(
      eventSchemas.terminal_dock_toggled.safeParse({ docked: 'yes', agent_kind: 'codex' }).success
    ).toBe(false)
    expect(
      eventSchemas.terminal_dock_passthrough_toggled.safeParse({
        active: true,
        agent_kind: 'unknown-agent'
      }).success
    ).toBe(false)
    expect(
      eventSchemas.terminal_dock_send_outcome.safeParse({
        outcome: 'sent',
        agent_kind: 'codex'
      }).success
    ).toBe(false)
    expect(
      eventSchemas.terminal_dock_send_outcome.safeParse({
        outcome: 'may-not-have-sent',
        agent_kind: 'codex',
        prompt: 'raw text'
      }).success
    ).toBe(false)
  })
})
