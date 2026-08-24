import { describe, it, expect, vi } from 'vitest'
import {
  createAskAttachedSurfaceRoster,
  trackAskSurfacePaneSubscription,
  untrackAskSurfacePaneSubscription,
  type AskAttachedSurfaceRosterHost
} from './ask-attached-surface-roster'
import { ASK_SURFACE_CLIENT_CAPABILITY } from '../../shared/fork-ask-question-tool/ask-question-capability'

function roster(hasLocalRendererWindow = false) {
  const host: AskAttachedSurfaceRosterHost = { hasLocalRendererWindow: () => hasLocalRendererWindow }
  return createAskAttachedSurfaceRoster(host)
}

describe('AskAttachedSurfaceRoster', () => {
  it('gains an entry on subscribe and loses it on detach', () => {
    const r = roster()
    r.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
    r.trackPaneSubscription('conn-1', 'pane:1')
    expect(r.hasCapableOwner('pane:1')).toBe(true)

    r.untrackPaneSubscription('conn-1', 'pane:1')
    expect(r.hasCapableOwner('pane:1')).toBe(false)
  })

  it('keeps ownership alive across an overlapping second subscription until both detach', () => {
    const r = roster()
    r.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
    r.trackPaneSubscription('conn-1', 'pane:1')
    r.trackPaneSubscription('conn-1', 'pane:1')

    r.untrackPaneSubscription('conn-1', 'pane:1')
    expect(r.hasCapableOwner('pane:1')).toBe(true)

    r.untrackPaneSubscription('conn-1', 'pane:1')
    expect(r.hasCapableOwner('pane:1')).toBe(false)
  })

  it('leaves no phantom owner once a dropped connection is forgotten', () => {
    const r = roster()
    r.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
    r.trackPaneSubscription('conn-1', 'pane:1')
    expect(r.hasCapableOwner('pane:1')).toBe(true)

    // A dropped socket never sends an unsubscribe frame — forgetConnection is the sweep.
    r.forgetConnection('conn-1')
    expect(r.hasCapableOwner('pane:1')).toBe(false)
  })

  it('does not satisfy the predicate for a different pane the same connection does not own', () => {
    const r = roster()
    r.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])
    r.trackPaneSubscription('conn-1', 'pane:a')

    expect(r.hasCapableOwner('pane:a')).toBe(true)
    expect(r.hasCapableOwner('pane:b')).toBe(false)
  })

  it('does not satisfy the predicate when the owning connection never advertised the ask capability', () => {
    const r = roster()
    r.trackPaneSubscription('conn-1', 'pane:1')

    expect(r.hasCapableOwner('pane:1')).toBe(false)
  })

  it('is satisfied by the local desktop renderer window for any pane, with no roster entry', () => {
    const r = roster(true)
    expect(r.hasCapableOwner('pane:never-subscribed')).toBe(true)
  })
})

describe('trackAskSurfacePaneSubscription / untrackAskSurfacePaneSubscription', () => {
  function fakeRuntime(paneKeyByHandle: Record<string, string | null>) {
    const askRoster = createAskAttachedSurfaceRoster({ hasLocalRendererWindow: () => false })
    return {
      getTerminalPaneKey: vi.fn((handle: string) => paneKeyByHandle[handle] ?? null),
      getAskServices: () => ({ roster: askRoster }),
      askRoster
    }
  }

  it('resolves the handle to a pane key and tracks/untracks it', () => {
    const runtime = fakeRuntime({ 'term-1': 'pane:1' })
    runtime.askRoster.recordConnectionCapabilities('conn-1', [ASK_SURFACE_CLIENT_CAPABILITY])

    trackAskSurfacePaneSubscription(runtime, 'conn-1', 'term-1')
    expect(runtime.askRoster.hasCapableOwner('pane:1')).toBe(true)

    untrackAskSurfacePaneSubscription(runtime, 'conn-1', 'term-1')
    expect(runtime.askRoster.hasCapableOwner('pane:1')).toBe(false)
  })

  it('is a no-op when the handle resolves to no pane key', () => {
    const runtime = fakeRuntime({ 'term-1': null })
    expect(() => trackAskSurfacePaneSubscription(runtime, 'conn-1', 'term-1')).not.toThrow()
    expect(() => untrackAskSurfacePaneSubscription(runtime, 'conn-1', 'term-1')).not.toThrow()
  })
})
