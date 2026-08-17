import { describe, expect, it } from 'vitest'
import {
  classifyPrelaunchStage,
  extractDispatchTerminalHandle
} from './pipeline-driver-stage-classify'

describe('classifyPrelaunchStage', () => {
  it('classifies stage B when no spawn-attempt row exists (durable proof nothing spawned)', () => {
    expect(classifyPrelaunchStage(undefined)).toBe('B')
  })

  it('classifies stage C when a spawn-attempt row exists, committed or not', () => {
    expect(classifyPrelaunchStage({ spawn_attempt_at: 'now', spawn_committed_at: 'now' })).toBe('C')
    expect(classifyPrelaunchStage({ spawn_attempt_at: 'now', spawn_committed_at: null })).toBe('C')
  })
})

describe('extractDispatchTerminalHandle', () => {
  it('finds the created agent terminal effect', () => {
    const handle = extractDispatchTerminalHandle([
      { kind: 'worktree', action: 'reused', id: 'wt-1' },
      { kind: 'terminal', role: 'agent', action: 'created', id: 'term-1' }
    ])
    expect(handle).toBe('term-1')
  })

  it('returns undefined when no terminal was ever created (stage-B territory)', () => {
    const handle = extractDispatchTerminalHandle([
      { kind: 'worktree', action: 'reused', id: 'wt-1' }
    ])
    expect(handle).toBeUndefined()
  })

  it('ignores a reused (not created) terminal effect', () => {
    const handle = extractDispatchTerminalHandle([
      { kind: 'terminal', role: 'agent', action: 'reused', id: 'term-1' }
    ])
    expect(handle).toBeUndefined()
  })
})
