import { describe, expect, it } from 'vitest'
import { canInspectClaudeStatusLine } from './use-hooks-and-mcp'

describe('canInspectClaudeStatusLine', () => {
  it.each([
    ['claude', true, true],
    ['claude', false, false],
    ['codex', true, false],
    [undefined, true, false]
  ])('gates %s on local execution %s', (agentType, isLocalExecution, expected) => {
    expect(canInspectClaudeStatusLine(agentType, isLocalExecution)).toBe(expected)
  })
})
