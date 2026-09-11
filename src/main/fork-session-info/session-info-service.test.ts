import { describe, expect, it } from 'vitest'
import { SessionInfoService } from './session-info-service'

describe('SessionInfoService', () => {
  it('clears prior-session fields and ignores a late statusline post', () => {
    const service = new SessionInfoService()
    service.ingestStatusLineBody(
      {
        paneKey: 'tab:leaf',
        payload: JSON.stringify({
          session_id: 'session-1',
          context_window: { used_percentage: 80 }
        })
      },
      100
    )
    expect(service.getSnapshot()['tab:leaf']?.context?.usedPercentage).toBe(80)

    service.observeAgentHook({
      source: 'claude',
      paneKey: 'tab:leaf',
      connectionId: null,
      hookEventName: 'SessionStart',
      providerSession: { key: 'session_id', id: 'session-2' },
      payload: { state: 'working', prompt: '' },
      receivedAt: 200
    })
    expect(service.getSnapshot()['tab:leaf']).toEqual({
      paneKey: 'tab:leaf',
      provider: 'claude',
      providerSessionId: 'session-2',
      updatedAt: 200
    })

    service.ingestStatusLineBody(
      {
        paneKey: 'tab:leaf',
        payload: JSON.stringify({
          session_id: 'session-1',
          context_window: { used_percentage: 99 }
        })
      },
      300
    )
    expect(service.getSnapshot()['tab:leaf']?.providerSessionId).toBe('session-2')
    expect(service.getSnapshot()['tab:leaf']?.context).toBeUndefined()
  })

  it('retains known fields across sparse posts from the same session', () => {
    const service = new SessionInfoService()
    service.ingestStatusLineBody(
      {
        paneKey: 'tab:leaf',
        payload: JSON.stringify({
          session_id: 'session-1',
          model: { display_name: 'Opus' },
          context_window: { used_percentage: 42 },
          cost: { total_lines_added: 7 }
        })
      },
      100
    )
    service.ingestStatusLineBody(
      {
        paneKey: 'tab:leaf',
        payload: JSON.stringify({ session_id: 'session-1', rate_limits: {} })
      },
      200
    )

    expect(service.getSnapshot()['tab:leaf']).toMatchObject({
      identity: { modelDisplayName: 'Opus', updatedAt: 100 },
      context: { usedPercentage: 42, updatedAt: 100 },
      filesTouched: { linesAdded: 7, updatedAt: 100 }
    })
  })

  it('marks plan windows only after the selected account accepts the post', () => {
    const service = new SessionInfoService()
    service.ingestStatusLineBody(
      {
        paneKey: 'tab:leaf',
        configDir: '/home/dev/.claude',
        payload: JSON.stringify({
          session_id: 'session-1',
          context_window: { used_percentage: 20 },
          rate_limits: { five_hour: { used_percentage: 8 } }
        })
      },
      100
    )
    expect(service.getSnapshot()['tab:leaf']?.planWindowsAcceptedAt).toBeUndefined()
    service.confirmPlanWindowsForAccount('/another/account', 101)
    expect(service.getSnapshot()['tab:leaf']?.planWindowsAcceptedAt).toBeUndefined()

    service.ingestStatusLineBody(
      {
        paneKey: 'tab:leaf',
        configDir: '/home/dev/.claude',
        payload: JSON.stringify({
          session_id: 'session-1',
          context_window: { used_percentage: 21 },
          rate_limits: { five_hour: { used_percentage: 9 } }
        })
      },
      200
    )
    service.confirmPlanWindowsForAccount('/home/dev/.claude', 201)
    expect(service.getSnapshot()['tab:leaf']?.planWindowsAcceptedAt).toBe(201)
  })

  it('clears pane telemetry on terminal teardown and pushes a tombstone', () => {
    const service = new SessionInfoService()
    const updates: unknown[] = []
    service.subscribe((telemetry) => updates.push(telemetry))
    service.ingestStatusLineBody(
      {
        paneKey: 'tab:leaf',
        payload: JSON.stringify({
          session_id: 'session-1',
          context_window: { used_percentage: 20 }
        })
      },
      100
    )
    service.clearPane('tab:leaf')
    expect(service.getSnapshot()).toEqual({})
    expect(updates.at(-1)).toMatchObject({ paneKey: 'tab:leaf', provider: '' })
  })
})
