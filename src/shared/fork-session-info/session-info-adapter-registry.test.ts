import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../agent-status-types'
import { buildSessionInfo } from './index'

function status(agentType = 'claude'): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'ship it',
    updatedAt: 200,
    stateStartedAt: 150,
    stateHistory: [{ state: 'done', prompt: '', startedAt: 100 }],
    agentType,
    model: 'claude-opus',
    paneKey: 'tab:leaf',
    worktreeId: 'wt',
    toolName: 'Edit',
    subagents: [{ id: 'child', state: 'working', startedAt: 180 }],
    providerSession: { key: 'session_id', id: 'session-1', transcriptPath: '/tmp/one.jsonl' }
  }
}

describe('session info adapter registry', () => {
  it('assembles Claude data only when pane and provider-session identity match', () => {
    const result = buildSessionInfo({
      paneKey: 'tab:leaf',
      status: status(),
      telemetry: {
        paneKey: 'tab:leaf',
        provider: 'claude',
        providerSessionId: 'session-1',
        identity: {
          modelDisplayName: 'Opus',
          cwd: '/repo',
          agentVersion: '2.1.250',
          updatedAt: 220
        },
        context: { usedPercentage: 42, windowSize: 200_000, updatedAt: 220 },
        filesTouched: { linesAdded: 12, linesRemoved: 3, updatedAt: 220 },
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 40,
          totalTokens: 100,
          turnCount: 2,
          branch: 'feature',
          updatedAt: 210
        },
        updatedAt: 220
      }
    })

    expect(result).toMatchObject({
      adapterId: 'claude',
      identity: { model: 'Opus', sessionId: 'session-1', cwd: '/repo', branch: 'feature' },
      usage: { status: 'ready', totalTokens: 100, turnCount: 2 },
      liveActivity: { state: 'working', toolName: 'Edit', subagentCount: 1 },
      context: { status: 'ready', usedPercentage: 42, windowSize: 200_000 },
      filesTouched: { linesAdded: 12, linesRemoved: 3 }
    })
  })

  it('uses transcript context until statusline telemetry arrives', () => {
    const result = buildSessionInfo({
      paneKey: 'tab:leaf',
      status: status(),
      telemetry: {
        paneKey: 'tab:leaf',
        provider: 'claude',
        providerSessionId: 'session-1',
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadTokens: 30,
          cacheWriteTokens: 40,
          totalTokens: 100,
          turnCount: 1,
          contextFallback: {
            usedPercentage: 51,
            remainingPercentage: 49,
            windowSize: 200_000,
            updatedAt: 210
          },
          updatedAt: 210
        },
        updatedAt: 210
      }
    })

    expect(result.context).toMatchObject({
      status: 'ready',
      usedPercentage: 51,
      windowSize: 200_000,
      updatedAt: 210
    })
  })

  it('omits unsupported sections and rejects telemetry from the prior session', () => {
    const unsupported = buildSessionInfo({ paneKey: 'tab:leaf', status: status('gemini') })
    expect(unsupported.usage).toBeUndefined()
    expect(unsupported.context).toBeUndefined()
    expect(unsupported.filesTouched).toBeUndefined()

    const next = status()
    next.providerSession = { key: 'session_id', id: 'session-2' }
    const claude = buildSessionInfo({
      paneKey: 'tab:leaf',
      status: next,
      telemetry: {
        paneKey: 'tab:leaf',
        provider: 'claude',
        providerSessionId: 'session-1',
        context: { usedPercentage: 99, updatedAt: 220 },
        updatedAt: 220
      }
    })
    expect(claude.context).toEqual({
      status: 'waiting',
      fiveHour: undefined,
      sevenDay: undefined,
      updatedAt: undefined
    })
  })

  it('omits host-only telemetry sections for a remote execution host', () => {
    const result = buildSessionInfo({
      paneKey: 'tab:leaf',
      status: status(),
      localTelemetryAvailable: false
    })
    expect(result.identity?.sessionId).toBe('session-1')
    expect(result.liveActivity?.state).toBe('working')
    expect(result.usage).toBeUndefined()
    expect(result.context).toBeUndefined()
    expect(result.filesTouched).toBeUndefined()
  })
})
