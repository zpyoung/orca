import { describe, expect, it } from 'vitest'
import { parseClaudeSessionInfoStatusLineBody } from './claude-statusline-session-info'

function form(payload: unknown, paneKey = 'tab:leaf'): Record<string, string> {
  return { paneKey, configDir: '/home/dev/.claude', payload: JSON.stringify(payload) }
}

describe('parseClaudeSessionInfoStatusLineBody', () => {
  it('keeps context and identity without rate limits', () => {
    const parsed = parseClaudeSessionInfoStatusLineBody(
      form({
        session_id: 'session-1',
        transcript_path: '/tmp/session.jsonl',
        cwd: '/repo',
        version: '2.1.250',
        model: { id: 'claude-opus', display_name: 'Opus' },
        output_style: { name: 'default' },
        context_window: {
          used_percentage: 37.5,
          remaining_percentage: 62.5,
          context_window_size: 200_000
        },
        cost: { total_lines_added: 12, total_lines_removed: 4 }
      }),
      123
    )

    expect(parsed).toEqual({
      configDir: '/home/dev/.claude',
      fiveHour: null,
      sevenDay: null,
      paneKey: 'tab:leaf',
      telemetry: {
        paneKey: 'tab:leaf',
        provider: 'claude',
        providerSessionId: 'session-1',
        identity: {
          sessionId: 'session-1',
          transcriptPath: '/tmp/session.jsonl',
          cwd: '/repo',
          modelId: 'claude-opus',
          modelDisplayName: 'Opus',
          agentVersion: '2.1.250',
          outputStyle: 'default',
          updatedAt: 123
        },
        context: {
          usedPercentage: 37.5,
          remainingPercentage: 62.5,
          windowSize: 200_000,
          updatedAt: 123
        },
        filesTouched: { linesAdded: 12, linesRemoved: 4, updatedAt: 123 },
        updatedAt: 123
      }
    })
  })

  it('preserves rate limits when session telemetry is absent', () => {
    expect(
      parseClaudeSessionInfoStatusLineBody(
        form({ rate_limits: { five_hour: { used_percentage: 8 } } }, ''),
        123
      )
    ).toMatchObject({ fiveHour: { used_percentage: 8 }, telemetry: undefined })
  })

  it('rejects malformed, unbounded, and out-of-range telemetry fields', () => {
    expect(parseClaudeSessionInfoStatusLineBody(form({ context_window: {} }), 123)).toBeNull()
    expect(
      parseClaudeSessionInfoStatusLineBody(
        form({
          session_id: 'session-1',
          context_window: { used_percentage: 101, context_window_size: -1 },
          cost: { total_lines_added: -2 }
        }),
        123
      )?.telemetry
    ).toMatchObject({ identity: { sessionId: 'session-1' } })
  })
})
