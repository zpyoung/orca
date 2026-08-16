import { describe, expect, it } from 'vitest'
import { shouldAutoExitPassthroughOnAgentStatus } from './terminal-pane-dock-passthrough'

describe('shouldAutoExitPassthroughOnAgentStatus', () => {
  it('exits when a hook-backed agent goes from working to done', () => {
    expect(
      shouldAutoExitPassthroughOnAgentStatus({
        previousState: 'working',
        nextState: 'done',
        agentType: 'claude'
      })
    ).toBe(true)
  })

  it('exits on working to blocked and working to waiting too', () => {
    expect(
      shouldAutoExitPassthroughOnAgentStatus({
        previousState: 'working',
        nextState: 'blocked',
        agentType: 'claude'
      })
    ).toBe(true)
    expect(
      shouldAutoExitPassthroughOnAgentStatus({
        previousState: 'working',
        nextState: 'waiting',
        agentType: 'claude'
      })
    ).toBe(true)
  })

  it('exits for OSC/custom agents when the status slice observes the transition', () => {
    expect(
      shouldAutoExitPassthroughOnAgentStatus({
        previousState: 'working',
        nextState: 'done',
        agentType: 'some-unsupported-cli'
      })
    ).toBe(true)
  })

  it('does not exit without an identified status source', () => {
    expect(
      shouldAutoExitPassthroughOnAgentStatus({
        previousState: 'working',
        nextState: 'done',
        agentType: null
      })
    ).toBe(false)
  })

  it('does not exit for Command Code, whose status is scraped rather than hook-fed', () => {
    expect(
      shouldAutoExitPassthroughOnAgentStatus({
        previousState: 'working',
        nextState: 'done',
        agentType: 'command-code'
      })
    ).toBe(false)
    expect(
      shouldAutoExitPassthroughOnAgentStatus({
        previousState: 'working',
        nextState: 'blocked',
        agentType: 'command-code'
      })
    ).toBe(false)
  })

  it('does not exit when the agent was not already working', () => {
    expect(
      shouldAutoExitPassthroughOnAgentStatus({
        previousState: 'done',
        nextState: 'working',
        agentType: 'claude'
      })
    ).toBe(false)
    expect(
      shouldAutoExitPassthroughOnAgentStatus({
        previousState: null,
        nextState: 'done',
        agentType: 'claude'
      })
    ).toBe(false)
  })

  it('does not exit on a working-to-working ping or a full status removal', () => {
    expect(
      shouldAutoExitPassthroughOnAgentStatus({
        previousState: 'working',
        nextState: 'working',
        agentType: 'claude'
      })
    ).toBe(false)
    expect(
      shouldAutoExitPassthroughOnAgentStatus({
        previousState: 'working',
        nextState: null,
        agentType: 'claude'
      })
    ).toBe(false)
  })
})
